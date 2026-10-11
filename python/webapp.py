#!/usr/bin/env python3
"""
Interfaz web para deezload_mcp (explorar artistas/álbumes y descargar pistas).

Uso:
  python webapp.py                 # arranca en http://127.0.0.1:8000
  python webapp.py --host 0.0.0.0 --port 8080

La carpeta de descargas se configura con la variable de entorno DOWNLOADS_DIR
(por defecto 'downloads', en la carpeta de arriba: la comparten Python y Node). Cuántos archivos se descargan a la vez
(1 = en secuencia, hasta 5) se elige desde la interfaz y se guarda en ajustes.json.
"""
import argparse
import asyncio
import heapq
import shutil
import itertools
import json
import os
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import covers
import deezload_mcp as d
import songs

BASE = Path(__file__).resolve().parent
WEBUI = d.ROOT / "webui"  # interfaz compartida con la versión en Node
DOWNLOADS = d._resolve_dir(os.getenv("DOWNLOADS_DIR", "downloads"))

# Un solo proceso contra el bot: la navegación (buscar, abrir álbumes, pedir GET ALL) va de
# una en una. La descarga de archivos usa cupos: 1 = en secuencia, como el flujo original.
nav_lock = asyncio.Lock()
jobs: dict[str, "DownloadJob"] = {}
_job_seq = itertools.count()

SETTINGS_FILE = d.ROOT / "ajustes.json"  # compartido con la versión en Node
MAX_PARALLEL = 5


def _load_settings() -> dict:
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except Exception:  # no existe o está dañado: valores por defecto
        data = {}
    n = data.get("descargas_simultaneas", 1)
    return {"descargas_simultaneas": n if isinstance(n, int) and 1 <= n <= MAX_PARALLEL else 1}


def _save_settings(values: dict) -> None:
    SETTINGS_FILE.write_text(json.dumps(values, ensure_ascii=False, indent=2), encoding="utf-8")


class FileSlots:
    """Cupos para descargar archivos, con un límite que se puede cambiar en caliente.
    Los cupos se conceden por prioridad: primero el álbum pedido antes y, dentro de él,
    la pista de menor número. Con límite 1 se baja álbum por álbum y pista por pista."""

    def __init__(self, limit: int):
        self.limit, self.active = limit, 0
        self._waiting: list = []
        self._seq = itertools.count()

    def set_limit(self, limit: int) -> None:
        self.limit = limit  # si baja, las descargas en curso terminan y no entran nuevas
        self._wake()

    async def acquire(self, priority: tuple) -> None:
        fut = asyncio.get_running_loop().create_future()
        heapq.heappush(self._waiting, (priority, next(self._seq), fut))
        self._wake()
        try:
            await fut
        except asyncio.CancelledError:
            if fut.done() and not fut.cancelled():  # se concedió justo al cancelar: devolverlo
                self.release()
            raise

    def release(self) -> None:
        self.active -= 1
        self._wake()

    def _wake(self) -> None:
        while self.active < self.limit and self._waiting:
            _, _, fut = heapq.heappop(self._waiting)
            if fut.done():  # quien esperaba se canceló
                continue
            self.active += 1
            fut.set_result(True)


settings = _load_settings()
slots = FileSlots(settings["descargas_simultaneas"])
# Dos pistas con el mismo nombre de archivo nunca se escriben a la vez (Windows no distingue mayúsculas).
_file_locks: dict[str, asyncio.Lock] = {}
activity: dict[str, dict] = {}  # operaciones con el bot en curso o esperando turno

# Avisos en vivo (/api/eventos): cada cambio sube la versión y despierta a quien esté escuchando.
_version = 0
_changed = asyncio.Event()


def notify() -> None:
    """Hay algo nuevo que contar a la interfaz (descargas, actividad del bot o ajustes)."""
    global _version, _changed
    _version += 1
    event, _changed = _changed, asyncio.Event()
    event.set()


@asynccontextmanager
async def with_bot(kind: str, title: str, on_step=None):
    """Toma el turno del bot (nav_lock) y deja constancia de la operación para /api/actividad:
    primero aparece 'esperando' y, al conseguir el turno, 'en_curso' con el paso actual."""
    op = {"id": uuid.uuid4().hex[:8], "tipo": kind, "titulo": title, "estado": "esperando",
          "paso": None, "creado": time.time(), "inicio_paso": time.time()}
    activity[op["id"]] = op
    notify()

    def step(text: str) -> None:
        op["paso"], op["inicio_paso"] = text, time.time()
        if on_step is not None:
            on_step(text)
        notify()

    try:
        async with nav_lock:
            op["estado"] = "en_curso"
            step("Empezando…")
            token = d._progress.set(step)
            try:
                yield op
            finally:
                d._progress.reset(token)
    finally:
        activity.pop(op["id"], None)
        notify()


class DownloadRequest(BaseModel):
    artist: str
    album: str
    index: int = 0


class CoversRequest(BaseModel):
    artist: str             # nombre del artista tal como lo muestra el bot
    fans: int | None = None  # "Fans on Deezer" de la ficha, para no confundir homónimos
    albums: list[str] = []


class DownloadJob:
    def __init__(self, artist: str, album: str, index: int):
        self.id = uuid.uuid4().hex[:12]
        self.seq = next(_job_seq)  # orden de llegada: decide qué álbum descarga primero
        self.artist = artist
        self.album = album
        self.index = index
        self.status = "queued"  # queued | running | completed | error
        self.error: str | None = None
        self.tracks: list[dict] = []
        self.created = time.time()
        self.finished: float | None = None
        self.step: str | None = None  # paso actual mientras se preparan las pistas
        self.attempts = 1
        self.discography: str | None = None  # id de la discografía a la que pertenece, si aplica

    def reset_for_retry(self) -> None:
        """Deja el trabajo como nuevo para reintentarlo en su mismo lugar de la lista.
        Las pistas que ya quedaron completas en la carpeta se saltan al volver a bajar."""
        self.seq = next(_job_seq)  # vuelve a la cola detrás de lo que ya estaba pedido
        self.status, self.error, self.tracks = "queued", None, []
        self.step, self.finished = None, None
        self.attempts += 1

    def to_dict(self) -> dict:
        done = sum(1 for t in self.tracks if t["status"] in ("done", "exists"))
        existing = sum(1 for t in self.tracks if t["status"] == "exists")
        received = sum(t.get("progress") or 0 for t in self.tracks)
        size = sum(t.get("size") or 0 for t in self.tracks)
        return {
            "id": self.id,
            "artist": self.artist,
            "album": self.album,
            "status": self.status,
            "error": self.error,
            "paso": self.step,
            "intentos": self.attempts,
            "discografia": self.discography,
            "created": self.created,
            "finished": self.finished,
            "total": len(self.tracks),
            "done": done,
            "existing": existing,  # pistas que ya estaban en la carpeta y no se volvieron a bajar
            "received": received,
            "size": size,
            "tracks": self.tracks,
        }


def _song_of(info: dict, target: Path) -> tuple[str, str]:
    """(artista, título) de una pista: del nombre 'Artista - Título.ext' o, si no, de sus etiquetas."""
    parts = songs.split_name(target.name)
    if parts:
        return parts
    return info.get("performer") or "", info.get("title") or target.stem


def _find_existing(info: dict, target: Path) -> str | None:
    """Archivo de la carpeta que ya es esta canción (aunque el nombre no sea idéntico:
    tildes, ñ, signos o '(Album Version)'), o None si hay que descargarla."""
    artist, title = _song_of(info, target)
    found = songs.find(songs.folder_index(DOWNLOADS), title, [artist, info.get("performer")])
    if found:
        return found
    return target.name if target.exists() else None  # nombres sin el formato 'Artista - Título'


async def _fetch_track(job: DownloadJob, i: int, m, info: dict) -> None:
    """Descarga una pista cuando le toca cupo. Si ya está en la carpeta, no se vuelve a bajar.
    Se descarga a 'nombre.part' y se renombra al terminar: un archivo con su nombre final
    siempre está completo, aunque una descarga anterior se haya cortado."""
    track = job.tracks[i]
    target = DOWNLOADS / d._safe_name(info.get("file_name"), f"{m.id}.bin")
    part = target.with_name(target.name + ".part")
    # Un candado por canción (o por archivo, si el nombre no es 'Artista - Título'):
    # dos copias de la misma canción nunca se bajan a la vez.
    parts = songs.split_name(target.name)
    key = (f"{songs.artist_key(parts[0])}|{songs.title_key(parts[1])}" if parts
           else f"archivo|{target.name.lower()}")
    lock = _file_locks.setdefault(key, asyncio.Lock())
    try:
        async with lock:
            # Directo (sin hilo aparte): tarda milisegundos y así se respeta el orden de los turnos.
            existing = _find_existing(info, target)
            if existing:
                size = (DOWNLOADS / existing).stat().st_size
                track.update(status="exists", file=existing, path=str(DOWNLOADS / existing), size=size, progress=size)
                return
            await slots.acquire((job.seq, i))
            try:
                track["status"] = "downloading"
                notify()

                def _cb(received, total):
                    track["progress"] = received
                    if total:
                        track["size"] = total
                    notify()  # muchos por segundo: /api/eventos los agrupa

                path = await m.download_media(file=part, progress_callback=_cb)
                if not path:
                    raise RuntimeError("Telegram no entregó el archivo.")
                os.replace(path, target)
            finally:
                slots.release()
                if part.exists():  # descarga cortada: no dejar el temporal
                    try:
                        part.unlink()
                    except OSError:
                        pass
        track["path"] = str(target)
        track["file"] = target.name
        track["status"] = "done"
        track["size"] = target.stat().st_size
        track["progress"] = track["size"]
    except Exception as e:
        track["status"] = "error"
        track["error"] = str(e) or type(e).__name__
        track["progress"] = 0
    finally:
        notify()


async def _audios_single(job: DownloadJob) -> list:
    """Pide al bot las pistas de un álbum suelto: busca al artista, abre el álbum y pulsa GET ALL."""
    card_id, error = await d._album_card_id(job.artist, job.album, job.index)
    if card_id is None:
        raise RuntimeError((error or {}).get("error") or "No se encontró el álbum en el bot.")
    return await d.collect_get_all(card_id)


async def _run_job(job: DownloadJob, get_audios=None) -> None:
    """Descarga un álbum. `get_audios` cambia cómo se le piden las pistas al bot
    (la discografía reutiliza la lista de álbumes ya abierta)."""
    job.status = "running"
    notify()
    try:
        async with with_bot("descarga", job.album, on_step=lambda t: setattr(job, "step", t)):
            audios = await (get_audios or _audios_single)(job)
        job.step = None
        infos = [d.describe_media(m) or {} for m in audios]
        if not audios:
            raise RuntimeError("El bot no envió pistas para este álbum.")
        job.tracks = [
            {
                "title": info.get("title") or info.get("file_name") or f"Pista {i + 1}",
                "file_name": info.get("file_name"),
                "size": info.get("size") or 0,
                "progress": 0,
                "status": "pending",
                "path": None,
                "file": None,
            }
            for i, info in enumerate(infos)
        ]
        notify()
        await asyncio.gather(*(_fetch_track(job, i, m, infos[i]) for i, m in enumerate(audios)))
        failed = [t for t in job.tracks if t["status"] == "error"]
        if failed:
            job.status = "error"
            job.error = (f"No se pudieron descargar {len(failed)} de {len(job.tracks)} pistas. "
                         f"Primer error: {failed[0]['error']}")
        else:
            job.status = "completed"
    except Exception as e:
        job.status = "error"
        job.error = str(e)
        job.step = None
    finally:
        job.finished = time.time()
        notify()


# ------------------------------------------------------------ Discografías ---

DISC_PAUSE = float(os.getenv("DISC_PAUSE", "5"))  # segundos de pausa entre álbumes (no saturar al bot)
discographies: dict[str, "Discography"] = {}
_disc_lock = asyncio.Lock()  # una discografía a la vez; las demás esperan su turno


class Discography:
    """Descarga de varios álbumes de un artista, de uno en uno y en orden.
    Si un álbum falla se sigue con el siguiente y se reintenta una vez al final."""

    def __init__(self, artist: str, name: str, index: int, albums: list[dict]):
        self.id = uuid.uuid4().hex[:12]
        self.artist, self.name, self.index = artist, name, index
        self.albums = [{"title": a["title"], "section": a.get("section") or "", "status": "pending",
                        "job_id": None, "error": None} for a in albums]
        self.status = "queued"   # queued | running | paused | completed | canceled
        self.cancel_requested = False
        self.resume = asyncio.Event()
        self.resume.set()
        self.current: int | None = None
        self.list_id: int | None = None  # lista de álbumes abierta en el bot (se reutiliza)
        self.created = time.time()
        self.finished: float | None = None
        self.note: str | None = None     # p. ej. "Pausa entre álbumes"

    def to_dict(self) -> dict:
        count = lambda st: sum(1 for a in self.albums if a["status"] == st)
        return {"id": self.id, "artist": self.artist, "name": self.name, "status": self.status,
                "cancelando": self.cancel_requested and self.status in ("running", "paused"),
                "pausando": not self.resume.is_set() and self.status == "running",
                "created": self.created, "finished": self.finished, "current": self.current,
                "nota": self.note, "total": len(self.albums),
                "listos": count("completed"), "ya_estaban": count("exists"), "con_error": count("error"),
                "cancelados": count("canceled"), "albums": self.albums}

    def queued_keys(self) -> set[tuple[str, str]]:
        """(artista, álbum) de lo que todavía va a descargar: para no pedirlo dos veces."""
        if self.status in ("completed", "canceled"):
            return set()
        artist = songs.artist_key(self.artist)
        return {(artist, songs.title_key(a["title"])) for a in self.albums if a["status"] in ("pending", "running", "retry")}

    async def _audios(self, job: DownloadJob) -> list:
        """Pide las pistas usando la lista de álbumes ya abierta: abrir el álbum, GET ALL y volver."""
        if self.list_id is None:
            listing = await d.albums(self.artist, self.index)
            if "list_message_id" not in listing:
                raise RuntimeError(listing.get("error") or "El bot no mostró la lista de álbumes.")
            self.list_id = listing["list_message_id"]
        try:
            card_id, self.list_id, error = await d.album_card_in_list(self.list_id, job.album)
        except Exception:
            self.list_id = None  # se perdió la lista: el siguiente álbum la vuelve a abrir
            raise
        if card_id is None:
            raise RuntimeError(error)
        audios = await d.collect_get_all(card_id)
        try:
            self.list_id = await d.back_to_list(card_id, self.list_id)
        except Exception:
            self.list_id = None
        return audios

    async def _album(self, k: int, retry: bool = False) -> bool:
        album = self.albums[k]
        self.current, album["status"], album["error"] = k, "running", None
        notify()
        job = jobs.get(album["job_id"]) if retry and album["job_id"] else None
        if job:
            job.reset_for_retry()
        else:
            job = DownloadJob(self.artist, album["title"], self.index)
            job.discography = self.id
            jobs[job.id] = job
            album["job_id"] = job.id
        notify()
        await _run_job(job, self._audios)
        if job.status == "completed":
            album["status"] = "exists" if job.tracks and all(t["status"] == "exists" for t in job.tracks) else "completed"
            return True
        album["status"], album["error"] = "error", job.error
        return False

    async def _gate(self) -> bool:
        """Entre álbumes: espera si está en pausa; False si se canceló."""
        if not self.resume.is_set():
            self.status, self.note = "paused", None
            notify()
            await self.resume.wait()
        if self.cancel_requested:
            return False
        self.status = "running"
        return True

    async def run(self) -> None:
        try:
            async with _disc_lock:
                failed: list[int] = []
                for k in range(len(self.albums)):
                    if not await self._gate():
                        break
                    if not await self._album(k):
                        failed.append(k)
                    if k < len(self.albums) - 1 and DISC_PAUSE > 0:
                        self.note = "Pausa entre álbumes"
                        notify()
                        await asyncio.sleep(DISC_PAUSE)
                        self.note = None
                for k in failed:  # un segundo intento para los que fallaron
                    if not await self._gate():
                        break
                    self.albums[k]["status"] = "retry"
                    await self._album(k, retry=True)
        finally:
            for a in self.albums:
                if a["status"] in ("pending", "retry"):
                    a["status"] = "canceled"
            self.status = "canceled" if self.cancel_requested else "completed"
            self.current, self.note, self.finished = None, None, time.time()
            notify()


@asynccontextmanager
async def lifespan(app: FastAPI):
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    yield
    if d._client is not None and d._client.is_connected():
        await d._client.disconnect()


app = FastAPI(title="deezload web", lifespan=lifespan)
app.mount("/files", StaticFiles(directory=str(DOWNLOADS)), name="files")


class DiscographyAlbum(BaseModel):
    title: str
    section: str = ""


class DiscographyRequest(BaseModel):
    artist: str                  # lo que se buscó (el bot vuelve a buscar con esto)
    name: str = ""               # nombre del artista para mostrar
    index: int = 0
    albums: list[DiscographyAlbum]


@app.post("/api/discografias")
async def api_discography_start(req: DiscographyRequest):
    """Descarga, de uno en uno, los álbumes elegidos de un artista."""
    if not req.albums:
        raise HTTPException(status_code=422, detail="Elige al menos un lanzamiento.")
    disc = Discography(req.artist.strip(), (req.name or req.artist).strip(), req.index,
                       [a.model_dump() if hasattr(a, "model_dump") else a.dict() for a in req.albums])
    discographies[disc.id] = disc
    notify()
    asyncio.create_task(disc.run())
    return {"id": disc.id}


def _disc_or_404(disc_id: str) -> "Discography":
    disc = discographies.get(disc_id)
    if not disc:
        raise HTTPException(status_code=404, detail="Esa descarga de discografía ya no existe.")
    return disc


@app.post("/api/discografias/{disc_id}/pausar")
async def api_discography_pause(disc_id: str):
    """Pausa al terminar el álbum en curso."""
    disc = _disc_or_404(disc_id)
    if disc.status in ("completed", "canceled"):
        raise HTTPException(status_code=409, detail="Esa discografía ya terminó.")
    disc.resume.clear()
    if disc.status == "queued":
        disc.status = "paused"
    notify()
    return disc.to_dict()


@app.post("/api/discografias/{disc_id}/reanudar")
async def api_discography_resume(disc_id: str):
    disc = _disc_or_404(disc_id)
    if disc.status in ("completed", "canceled"):
        raise HTTPException(status_code=409, detail="Esa discografía ya terminó.")
    disc.resume.set()
    if disc.status == "paused":
        disc.status = "running" if disc.current is not None else "queued"
    notify()
    return disc.to_dict()


@app.post("/api/discografias/{disc_id}/cancelar")
async def api_discography_cancel(disc_id: str):
    """Cancela: el álbum en curso termina y no se empiezan más."""
    disc = _disc_or_404(disc_id)
    if disc.status in ("completed", "canceled"):
        raise HTTPException(status_code=409, detail="Esa discografía ya terminó.")
    disc.cancel_requested = True
    disc.resume.set()  # si estaba en pausa, que salga del bucle
    notify()
    return disc.to_dict()


@app.get("/api/discografias")
async def api_discographies():
    return [x.to_dict() for x in sorted(discographies.values(), key=lambda x: x.created, reverse=True)]


class EstimateRequest(BaseModel):
    ids: list[int]


@app.post("/api/estimacion")
async def api_estimate(req: EstimateRequest):
    """Pistas y duración de varios álbumes de Deezer (para estimar el tamaño) y espacio libre."""
    ids = list(dict.fromkeys(req.ids))[:200]
    details = await asyncio.gather(*(covers.album_details(i) for i in ids))
    try:
        free = shutil.disk_usage(DOWNLOADS).free
    except OSError:
        free = None
    return {"albumes": {str(x["id"]): {"pistas": x.get("pistas"), "duracion": x.get("duracion")}
                        for x in details if "error" not in x},
            "libre": free}


@app.get("/")
async def index():
    return FileResponse(WEBUI / "index.html")


@app.get("/api/config")
async def config():
    return {"bot": d.BOT, "downloads_dir": str(DOWNLOADS)}


@app.get("/api/albums")
async def api_albums(artist: str, index: int = 0):
    try:
        async with with_bot("buscar", artist.strip()):
            return await d.albums(artist, index)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/tracks")
async def api_tracks(artist: str, album: str, index: int = 0):
    try:
        async with with_bot("album", album.strip()):
            return await d.album_tracks(artist, album, index)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/download")
async def api_download(req: DownloadRequest):
    key = (songs.artist_key(req.artist), songs.title_key(req.album))
    for disc in discographies.values():
        if key in disc.queued_keys():
            raise HTTPException(status_code=409,
                                detail=f"«{req.album.strip()}» ya está en la cola de la discografía de {disc.name}.")
    job = DownloadJob(req.artist.strip(), req.album.strip(), req.index)
    jobs[job.id] = job
    notify()
    asyncio.create_task(_run_job(job))
    return {"job_id": job.id}


class ExistingTrack(BaseModel):
    titulo: str
    artista: str = ""


class ExistingRequest(BaseModel):
    artist: str                 # artista del álbum (por si la canción no trae artista)
    tracks: list[ExistingTrack]


@app.post("/api/existentes")
async def api_existentes(req: ExistingRequest):
    """Qué canciones de la lista ya están en la carpeta de descargas. Compara artista y título
    con los archivos 'Artista - Título.ext' sin importar tildes, ñ, mayúsculas, signos ni
    etiquetas como '(Album Version)' o '(Remastered)'."""
    index = await asyncio.to_thread(songs.folder_index, DOWNLOADS)
    found = [i for i, t in enumerate(req.tracks) if songs.find(index, t.titulo, [t.artista, req.artist])]
    return {"existentes": found}


class SettingsRequest(BaseModel):
    descargas_simultaneas: int


@app.get("/api/ajustes")
async def get_settings():
    return {**settings, "maximo": MAX_PARALLEL, "en_curso": slots.active}


@app.post("/api/ajustes")
async def set_settings(req: SettingsRequest):
    """Cambia cuántos archivos se descargan a la vez. Se aplica también a lo que está en curso."""
    n = req.descargas_simultaneas
    if not 1 <= n <= MAX_PARALLEL:
        raise HTTPException(status_code=422, detail=f"Elige un número entre 1 y {MAX_PARALLEL}.")
    settings["descargas_simultaneas"] = n
    slots.set_limit(n)
    notify()
    out = {**settings, "maximo": MAX_PARALLEL, "en_curso": slots.active}
    try:
        _save_settings(settings)
    except OSError as e:  # se aplica igual, pero no sobrevivirá a un reinicio
        out["aviso"] = f"Se aplicó, pero no se pudo guardar en {SETTINGS_FILE.name}: {e}"
    return out


@app.post("/api/covers")
async def api_covers(req: CoversRequest):
    """Carátulas de Deezer para los títulos dados. No usa el bot, así que no espera turno."""
    return await covers.find_covers(req.artist.strip(), req.albums, req.fans)


@app.get("/api/deezer/album/{album_id}")
async def api_deezer_album(album_id: int):
    """Sello, géneros, duración y fans de un álbum según Deezer (sin pasar por el bot)."""
    return await covers.album_details(album_id)


def _activity_list(with_seconds: bool = True) -> list[dict]:
    now = time.time()
    out = []
    for op in sorted(activity.values(), key=lambda o: o["creado"]):
        item = {"id": op["id"], "tipo": op["tipo"], "titulo": op["titulo"], "estado": op["estado"],
                "paso": op["paso"], "creado": op["creado"], "inicio_paso": op["inicio_paso"]}
        if with_seconds:  # en /api/eventos el navegador cuenta los segundos con su propio reloj
            item["segundos"] = round(now - op["creado"])
            item["segundos_paso"] = round(now - op["inicio_paso"])
        out.append(item)
    return out


@app.get("/api/actividad")
async def api_actividad():
    """Operaciones con el bot: la que tiene el turno y las que esperan, en orden de llegada."""
    return _activity_list()


EVENT_BATCH = 0.3   # segundos para agrupar ráfagas de cambios (el progreso llega muchas veces por segundo)
EVENT_PING = 15     # segundos sin cambios antes de mandar una señal para mantener viva la conexión


def _sse(name: str, data: dict) -> str:
    return f"event: {name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.get("/api/eventos")
async def api_eventos(request: Request):
    """Avisos en vivo (Server-Sent Events). Al conectar se envía 'estado' con todo; después,
    'cambios' solo con lo que cambió: descargas modificadas, la actividad del bot o los ajustes.
    Sin cambios no se envía nada salvo un ping cada 15 s. El navegador se reconecta solo."""

    async def stream():
        sent_jobs: dict[str, str] = {}
        sent_activity = sent_settings = sent_discs = None
        seen = -1
        yield "retry: 3000\n\n"  # si se corta, el navegador reintenta a los 3 s
        while True:
            if seen >= 0:  # tras el primer envío, esperar a que haya algo nuevo
                event = _changed
                if _version == seen:
                    try:
                        await asyncio.wait_for(event.wait(), timeout=EVENT_PING)
                    except asyncio.TimeoutError:
                        if await request.is_disconnected():
                            return
                        yield ": ping\n\n"
                        continue
                await asyncio.sleep(EVENT_BATCH)
            if await request.is_disconnected():
                return
            first, seen = seen < 0, _version
            payload = {"ahora": time.time()}
            changed_jobs = []
            for job in jobs.values():
                data = job.to_dict()
                text = json.dumps(data, ensure_ascii=False, sort_keys=True)
                if sent_jobs.get(job.id) != text:
                    sent_jobs[job.id] = text
                    changed_jobs.append(data)
            act = _activity_list(with_seconds=False)
            act_text = json.dumps(act, ensure_ascii=False)
            set_now = {**settings, "maximo": MAX_PARALLEL}
            set_text = json.dumps(set_now, sort_keys=True)
            if first or changed_jobs:
                payload["jobs"] = changed_jobs
            if first or act_text != sent_activity:
                payload["actividad"], sent_activity = act, act_text
            if first or set_text != sent_settings:
                payload["ajustes"], sent_settings = set_now, set_text
            discs = [x.to_dict() for x in discographies.values()]
            discs_text = json.dumps(discs, ensure_ascii=False, sort_keys=True)
            if first or discs_text != sent_discs:
                payload["discografias"], sent_discs = discs, discs_text
            if len(payload) > 1:
                yield _sse("estado" if first else "cambios", payload)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/jobs")
async def api_jobs():
    return [j.to_dict() for j in sorted(jobs.values(), key=lambda j: j.created, reverse=True)]


@app.post("/api/jobs/{job_id}/reintentar")
async def api_retry(job_id: str):
    """Vuelve a intentar una descarga que falló (p. ej. 'El bot no envió pistas para este álbum')."""
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Esa descarga ya no existe. Pídela de nuevo desde el álbum.")
    if job.status != "error":
        raise HTTPException(status_code=409, detail="Solo se puede reintentar una descarga que falló.")
    job.reset_for_retry()
    notify()
    asyncio.create_task(_retry_job(job))
    return {"job_id": job.id}


async def _retry_job(job: DownloadJob) -> None:
    await _run_job(job)
    disc = discographies.get(job.discography or "")
    if disc:  # reintento a mano de un álbum de una discografía: actualizar su estado
        for a in disc.albums:
            if a["job_id"] == job.id and job.status == "completed":
                a["status"] = "exists" if job.tracks and all(t["status"] == "exists" for t in job.tracks) else "completed"
                a["error"] = None
        notify()


@app.get("/api/jobs/{job_id}")
async def api_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Trabajo no encontrado")
    return job.to_dict()


def main() -> None:
    parser = argparse.ArgumentParser(description="Interfaz web de deezload")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    import uvicorn

    sys.stdout.reconfigure(encoding="utf-8")
    print(f"deezload web -> http://{args.host}:{args.port}  (descargas en {DOWNLOADS})")
    # timeout_graceful_shutdown: las conexiones de /api/eventos no deben retrasar el cierre (Ctrl+C)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info", timeout_graceful_shutdown=3)


if __name__ == "__main__":
    main()
