#!/usr/bin/env python3
"""
Puente entre Claude y @deezload2bot usando tu cuenta de Telegram (Telethon).

Uso:
  python deezload_mcp.py login                   # 1ª vez: inicia sesión (teléfono + código)
  python deezload_mcp.py albums "Soda Stereo" [n] [--raw]  # álbumes por sección (n = artista elegido)
  python deezload_mcp.py tracks "Soda Stereo" "Signos" [n] # canciones de un álbum
  python deezload_mcp.py discography "Soda Stereo" [n]     # todos los álbumes con sus canciones
  python deezload_mcp.py album "Soda Stereo" "Signos" [n]  # prueba: abre un álbum y muestra la respuesta
  python deezload_mcp.py send "Soda Stereo"      # prueba: envía texto y muestra la respuesta cruda
  python deezload_mcp.py click <msg_id> "texto"  # prueba: pulsa un botón inline
  python deezload_mcp.py pages <msg_id>          # prueba: recorre todas las páginas de un mensaje
  python deezload_mcp.py inline "<consulta>"     # prueba: consulta inline (@bot <consulta>)
  python deezload_mcp.py pick "<consulta>" [n]   # prueba: elige el resultado inline n (0 = primero)
  python deezload_mcp.py getall <msg_id> [dir]   # descarga secuencial de un álbum (botón GET ALL)
  python deezload_mcp.py download "Soda Stereo" "Signos" [n] [dir]  # descarga secuencial de un álbum
  python deezload_mcp.py                         # modo servidor MCP (stdio) para Claude
"""
import asyncio
import contextvars
import json
import os
import re
import sys
from pathlib import Path

from dotenv import load_dotenv
from telethon import TelegramClient

BASE = Path(__file__).resolve().parent  # carpeta python\ (aquí vive la sesión de Telethon)
# Lo compartido con la versión en Node (.env, downloads, ajustes.json, webui) está en la carpeta
# de arriba. Si no se encuentra el .env allí, se usa esta misma carpeta (estructura antigua).
ROOT = BASE.parent if (BASE.parent / ".env").exists() or not (BASE / ".env").exists() else BASE
load_dotenv(ROOT / ".env")

API_ID = int(os.environ["TG_API_ID"])
API_HASH = os.environ["TG_API_HASH"]
BOT = os.getenv("DEEZ_BOT", "deezload2bot")
SESSION = str(BASE / os.getenv("TG_SESSION", "deezload"))
QUIET_SECONDS = float(os.getenv("QUIET_SECONDS", "3"))  # silencio del bot = respuesta completa
MAX_WAIT = float(os.getenv("MAX_WAIT", "30"))
MAX_PAGES = int(os.getenv("MAX_PAGES", "40"))
# Tras pulsar GET ALL: cuánto esperar como máximo a que llegue el PRIMER archivo, y cuánto
# esperar sin archivos nuevos cuando la ficha dice que faltan pistas por llegar.
FILES_WAIT = float(os.getenv("FILES_WAIT", "90"))
FILES_GAP = float(os.getenv("FILES_GAP", "30"))
TOTAL_TRACKS_RE = re.compile(r"total tracks\s*:\s*(\d+)", re.I)

# Botones de "siguiente página" (solo etiquetas cortas, para no confundir con nombres de álbum)
ARTIST_PREFIX = os.getenv("ARTIST_PREFIX", ".art ")

# Botones de navegación (siguiente / anterior / volver). Antes se buscaba la palabra dentro del
# texto, y un álbum como "Quiero Más" o "Back in Black" se tomaba por un botón de página.
# Ahora un botón de navegación es, como mucho, UNA palabra de navegación rodeada de símbolos
# ("Next »", "« Prev", "➡️", "🔙 BACK"), o solo flechas.
NEXT_SYMBOLS, PREV_SYMBOLS, CLOSE_SYMBOLS = "»›→➡▶⏩", "«‹←⬅◀⏪", "❌✖🔙"
NAV_WORDS = {"next": "next", "siguiente": "next", "sig": "next",
             "prev": "prev", "previous": "prev", "anterior": "prev", "ant": "prev",
             "back": "back", "atrás": "back", "atras": "back", "close": "back", "cerrar": "back"}
# Palabras que también son títulos habituales ("Más" de Alejandro Sanz, "Volver"...):
# solo cuentan como navegación si van acompañadas de una flecha o símbolo.
NAV_WORDS_WITH_SYMBOL = {"más": "next", "mas": "next", "more": "next", "volver": "back"}
NAV_SHAPE_RE = re.compile(r"[^\w]*([^\W\d_]+\.?)?[^\w]*")


def nav_kind(text: str) -> str | None:
    """'next', 'prev' o 'back' si el botón es de navegación; None si parece un álbum u otra cosa."""
    t = (text or "").strip()
    if not t or len(t) > 15:
        return None
    m = NAV_SHAPE_RE.fullmatch(t)
    if not m:
        return None
    word = (m.group(1) or "").rstrip(".").lower()
    has_symbol = len(word) < len(t)
    if word:
        return NAV_WORDS.get(word) or (NAV_WORDS_WITH_SYMBOL.get(word) if has_symbol else None)
    if ">>" in t or any(c in t for c in NEXT_SYMBOLS):
        return "next"
    if "<<" in t or any(c in t for c in PREV_SYMBOLS):
        return "prev"
    if any(c in t for c in CLOSE_SYMBOLS):
        return "back"
    return None


COUNTER_RE = re.compile(r"^\s*\d+\s*(/|of|de)\s*\d+\s*$", re.I)

_client = None

# Avisos de progreso: la interfaz web registra aquí una función para saber en qué paso va
# cada operación con el bot. En la CLI y en el modo MCP no hay nadie escuchando y no hace nada.
_progress: contextvars.ContextVar = contextvars.ContextVar("deezload_progress", default=None)


def report(step: str) -> None:
    cb = _progress.get()
    if cb is not None:
        try:
            cb(step)
        except Exception:
            pass


# ---------------------------------------------------------------- Telegram ---

async def get_client(interactive: bool = False) -> TelegramClient:
    global _client
    if _client is None:
        _client = TelegramClient(SESSION, API_ID, API_HASH)
    if not _client.is_connected():
        await _client.connect()
    if not await _client.is_user_authorized():
        if interactive:
            await _client.start()
        else:
            raise RuntimeError(
                "Sesión de Telegram no iniciada. Ejecuta primero: python deezload_mcp.py login"
            )
    return _client


def describe_button(b) -> dict:
    # Usa las propiedades de MessageButton, que funcionan igual en todas las versiones de Telethon
    if b.inline_query is not None:
        return {"text": b.text, "kind": "switch_inline", "inline_query": b.inline_query}
    if b.data is not None:
        return {"text": b.text, "kind": "callback"}
    if b.url:
        return {"text": b.text, "kind": "url", "url": b.url}
    return {"text": b.text, "kind": "other"}


def describe_media(msg) -> dict | None:
    """Metadatos del archivo adjunto (audio FLAC, ZIP...), si lo hay."""
    if msg is None or msg.media is None:
        return None
    if msg.photo is not None:
        return {"kind": "photo"}
    doc = msg.document
    if doc is None:
        return {"kind": type(msg.media).__name__}
    info = {"kind": "document", "mime": doc.mime_type, "size": doc.size}
    for a in doc.attributes:
        name = type(a).__name__
        if name == "DocumentAttributeFilename":
            info["file_name"] = a.file_name
        elif name == "DocumentAttributeAudio":
            info["audio"] = True
            info["title"] = a.title
            info["performer"] = a.performer
            info["duration"] = a.duration
        elif name == "DocumentAttributeVideo":
            info["video"] = True
            info["duration"] = a.duration
    return info


def snapshot(msg) -> dict:
    rows = [[describe_button(b) for b in row] for row in (msg.buttons or [])]
    data = {"message_id": msg.id, "text": msg.message or "", "buttons": rows}
    media = describe_media(msg)
    if media is not None:
        data["media"] = media
    return data


def _signature(msgs):
    return tuple((m.id, m.edit_date, m.message, len(m.buttons or [])) for m in msgs)


async def wait_settled(client, after_id: int, watch_ids=()):
    """Espera a que el bot deje de enviar/editar mensajes y los devuelve en orden."""
    loop = asyncio.get_running_loop()
    start = loop.time()
    last_sig, last_change, msgs = None, start, []
    while loop.time() - start < MAX_WAIT:
        new = [m for m in await client.get_messages(BOT, min_id=after_id, limit=50) if not m.out or m.via_bot_id]
        watched = []
        if watch_ids:
            watched = [m for m in await client.get_messages(BOT, ids=list(watch_ids)) if m]
        msgs = sorted({m.id: m for m in watched + new}.values(), key=lambda m: m.id)
        sig, now = _signature(msgs), loop.time()
        if sig != last_sig:
            last_sig, last_change = sig, now
        elif msgs and now - last_change >= QUIET_SECONDS:
            break
        await asyncio.sleep(1)
    return msgs


def find_button(msg, match):
    for row in msg.buttons or []:
        for b in row:
            if match(b.text):
                return b
    return None


async def press(button):
    try:
        await button.click()
    except Exception as e:  # algunos bots no contestan el callback a tiempo; el mensaje igual cambia
        if "timeout" not in type(e).__name__.lower() and "Timeout" not in str(e):
            raise


async def last_id(client) -> int:
    msgs = await client.get_messages(BOT, limit=1)
    return msgs[0].id if msgs else 0


# ------------------------------------------------------------------ Acciones ---

async def send(text: str):
    client = await get_client()
    sent = await client.send_message(BOT, text)
    return [snapshot(m) for m in await wait_settled(client, sent.id)]


async def click(message_id: int, button_text: str):
    client = await get_client()
    msg = await client.get_messages(BOT, ids=message_id)
    if not msg or not msg.buttons:
        raise ValueError(f"El mensaje {message_id} no existe o no tiene botones.")
    needle = button_text.strip().lower()
    btn = find_button(msg, lambda t: t.strip().lower() == needle) or \
          find_button(msg, lambda t: needle in t.lower())
    if not btn:
        raise ValueError(f"No hay botón que coincida con '{button_text}'.")
    if btn.inline_query is not None:
        return [{"inline_button": describe_button(btn),
                 "hint": "Botón de búsqueda inline: usa deezload_inline con inline_query + el texto a buscar."}]
    before = await last_id(client)
    await press(btn)
    msgs = await wait_settled(client, before, watch_ids=[message_id])
    return [snapshot(m) for m in msgs]


async def all_pages(message_id: int, what: str | None = None):
    """Sigue los botones de 'siguiente' y devuelve todas las páginas."""
    client = await get_client()
    pages, seen, current = [], set(), message_id
    for _ in range(MAX_PAGES):
        msg = await client.get_messages(BOT, ids=current)
        if not msg:
            break
        snap = snapshot(msg)
        key = json.dumps([snap["text"], snap["buttons"]], ensure_ascii=False)
        if key in seen:
            break
        seen.add(key)
        pages.append(snap)
        if what:
            report(f"{what}: página {len(pages)}")
        nxt = find_button(msg, lambda t: nav_kind(t) == "next")
        if not nxt:
            break
        before = await last_id(client)
        await press(nxt)
        msgs = await wait_settled(client, before, watch_ids=[current])
        newer = [m for m in msgs if m.id > before and m.buttons]
        if newer:
            current = newer[-1].id
    return pages


async def inline(query: str):
    """Consulta inline (@bot <query>) y devuelve todos los resultados, siguiendo la paginación."""
    client = await get_client()
    out, offset = [], None
    for _ in range(MAX_PAGES):
        res = await client.inline_query(BOT, query, offset=offset)
        for r in res:
            out.append({"title": r.title, "description": r.description,
                        "type": r.type, "url": r.url, "id": r.result.id})
        offset = res.result.next_offset
        if not offset or not len(res):
            break
    return out


async def inline_pick(query: str, index: int = 0):
    """Elige el resultado nº `index` de una consulta inline (como tocarlo en Telegram)
    y devuelve lo que queda en el chat: el mensaje enviado vía bot y las respuestas del bot."""
    client = await get_client()
    offset, seen = None, 0
    for _ in range(MAX_PAGES):
        res = await client.inline_query(BOT, query, offset=offset)
        if index < seen + len(res):
            before = await last_id(client)
            await res[index - seen].click(BOT)
            return [snapshot(m) for m in await wait_settled(client, before)]
        seen += len(res)
        offset = res.result.next_offset
        if not offset or not len(res):
            break
    raise ValueError(f"La consulta inline solo tiene {seen} resultados.")


SEPARATOR_RE = re.compile(r"^[\s━─—_=·•\-]+$")
SKIP_RE = re.compile(r"^(get all|descargar todo|download all)\b", re.I)
GET_ALL_RE = re.compile(r"(get all|descargar todo|download all)", re.I)


def _parse_sections(pages, first_section="Albums"):
    """Convierte los botones de las páginas en {sección: [títulos]}.
    Una fila con separadores (━ Singles and EPs ━) abre una sección nueva."""
    sections = {first_section: []}
    current = first_section
    seen = set()
    for page in pages:
        for row in page["buttons"]:
            texts = [b["text"].strip() for b in row]
            if any(SEPARATOR_RE.match(t) for t in texts):
                header = [t for t in texts if t and not SEPARATOR_RE.match(t)]
                if header:
                    current = header[0]
                    sections.setdefault(current, [])
                continue
            for t in texts:
                if (not t or SEPARATOR_RE.match(t) or SKIP_RE.search(t) or COUNTER_RE.match(t)
                        or nav_kind(t) or TRACK_RE.match(t)):  # TRACK_RE: canciones de una ficha, no álbumes
                    continue
                if (current, t) not in seen:
                    seen.add((current, t))
                    sections[current].append(t)
    return {k: v for k, v in sections.items() if v}


async def albums(artist: str, index: int = 0, raw: bool = False):
    """Nombre del artista -> búsqueda inline -> ficha -> ALBUMS -> todas las páginas."""
    report(f"Buscando a «{artist}» en el bot")
    card_msgs = await inline_pick(ARTIST_PREFIX + artist, index)
    card = next((m for m in reversed(card_msgs)
                 if any("album" in b["text"].lower() for row in m["buttons"] for b in row)), None)
    if not card:
        return {"error": "El bot no mostró un botón de álbumes.", "respuesta": card_msgs}
    report("Abriendo la lista de álbumes")
    after = await click(card["message_id"], "ALBUMS")
    with_buttons = [m for m in after if m["buttons"]]
    target = with_buttons[-1]["message_id"] if with_buttons else card["message_id"]
    pages = await all_pages(target, "Leyendo la lista de álbumes")
    sections = _parse_sections(pages)
    result = {"artista": card["text"],
              "total": sum(len(v) for v in sections.values()),
              "secciones": sections,
              "list_message_id": target}
    if raw:
        result["paginas"] = pages
    return result


TRACKS_RE = re.compile(r"(track|canciones|songs|tracklist)", re.I)



def _album_button(msg, title: str, exact: bool = True):
    """Botón de la lista que corresponde al álbum `title` (coincidencia exacta o parcial)."""
    needle = title.strip().lower()
    if exact:
        return find_button(msg, lambda t: t.strip().lower() == needle)
    return find_button(msg, lambda t: needle in t.lower()
                       and not nav_kind(t))


async def _walk_list(list_id: int, match, title: str = ""):
    """Recorre una lista paginada del bot desde la página que muestra ahora, primero hacia
    delante y luego hacia atrás, hasta dar con una página donde `match(msg)` devuelva un botón.
    Funciona tanto si el bot edita la lista en el mismo mensaje como si envía uno por página.
    Devuelve (message_id, botón) o (None, None)."""
    client = await get_client()
    turned = 0
    for direction in ("next", "prev"):  # nunca "back": BACK sale de la lista
        current, seen = list_id, set()
        for _ in range(MAX_PAGES):
            msg = await client.get_messages(BOT, ids=current)
            if not msg or not msg.buttons:
                break
            btn = match(msg)
            if btn is not None:
                return current, btn
            snap = snapshot(msg)
            key = json.dumps([snap["text"], snap["buttons"]], ensure_ascii=False)
            if key in seen:
                break
            seen.add(key)
            nav = find_button(msg, lambda t: nav_kind(t) == direction)
            if not nav:
                break
            turned += 1
            report(f"Buscando «{title}» en otra página de la lista ({turned} revisadas)")
            before = await last_id(client)
            await press(nav)
            msgs = await wait_settled(client, before, watch_ids=[current])
            newer = [m for m in msgs if m.id > before and m.buttons]
            if newer:
                current = newer[-1].id
    return None, None


async def press_nav(message_id: int, kind: str):
    """Pulsa el botón de navegación `kind` ('next', 'prev' o 'back') de un mensaje.
    No usa coincidencia parcial: en un álbum como "Back in Black" una canción contiene "back"."""
    client = await get_client()
    msg = await client.get_messages(BOT, ids=message_id)
    btn = find_button(msg, lambda t: nav_kind(t) == kind) if msg else None
    if not btn:
        raise ValueError(f"El mensaje {message_id} no tiene botón de navegación '{kind}'.")
    return await click(message_id, btn.text)


async def click_in_list(list_id: int, title: str):
    """Pulsa el álbum `title` en la lista de álbumes aunque esté en otra página
    (después de all_pages la lista suele quedar en la última). Busca primero una
    coincidencia exacta en todas las páginas y solo después una parcial.
    Devuelve (mensajes tras pulsar, id del mensaje de la lista donde estaba el álbum)."""
    for exact in (True, False):
        msg_id, btn = await _walk_list(list_id, lambda m, exact=exact: _album_button(m, title, exact), title)
        if btn is not None:
            report(f"Abriendo «{btn.text}»")
            return await click(msg_id, btn.text), msg_id
    raise ValueError(f"No se encontró el álbum '{title}' en ninguna página de la lista.")


async def album_view(artist: str, album: str, index: int = 0):
    """Abre un álbum desde la lista de álbumes del artista y devuelve la respuesta cruda del bot.
    Si el bot muestra un botón de canciones (TRACKS...), lo pulsa y recorre sus páginas.
    Nunca pulsa botones de canciones individuales ni de descarga."""
    listing = await albums(artist, index)
    if "list_message_id" not in listing:
        return listing
    opened, _ = await click_in_list(listing["list_message_id"], album)
    result = {"album": album, "respuesta": opened}
    card = next((m for m in reversed(opened)
                 if any(TRACKS_RE.search(b["text"]) and len(b["text"]) <= 20
                        for row in m["buttons"] for b in row)), None)
    if card:
        btn = next(b["text"] for row in card["buttons"] for b in row
                   if TRACKS_RE.search(b["text"]) and len(b["text"]) <= 20)
        after = await click(card["message_id"], btn)
        with_buttons = [m for m in after if m["buttons"]]
        target = with_buttons[-1]["message_id"] if with_buttons else card["message_id"]
        result["paginas_canciones"] = await all_pages(target, "Leyendo las canciones")
    return result


TRACK_RE = re.compile(r"^\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*\|\s*(.+?)\s*$")
HEADER_RE = re.compile(r"^\W*\s*([A-Za-zÁÉÍÓÚáéíóúñ ]+?)\s*:\s*(.+)$")


def _parse_album(pages):
    """Extrae la ficha (fecha, nº de pistas) y las canciones 'duración | Artista - Título'."""
    info = {}
    for line in (pages[0]["text"] if pages else "").splitlines():
        m = HEADER_RE.match(line)
        if m:
            info[m.group(1).strip().lower()] = m.group(2).strip()
    tracks = []
    for page in pages:
        for row in page["buttons"]:
            for b in row:
                m = TRACK_RE.match(b["text"])
                if not m:
                    continue
                duration, rest = m.groups()
                artist, _, title = rest.partition(" - ")
                if not title:
                    artist, title = "", rest
                tracks.append({"n": len(tracks) + 1, "titulo": title.strip(),
                               "artista": artist.strip(), "duracion": duration})
    expected = info.get("total tracks")
    out = {"fecha": info.get("date"), "pistas": tracks}
    if expected and expected.isdigit() and int(expected) != len(tracks):
        out["aviso"] = f"El bot indica {expected} pistas y se leyeron {len(tracks)}."
    return out


def _has_tracks(msg):
    return any(TRACK_RE.match(b["text"]) for row in msg["buttons"] for b in row)


async def _list_alive(list_id: int) -> bool:
    client = await get_client()
    msg = await client.get_messages(BOT, ids=list_id)
    return bool(msg and msg.buttons and not _has_tracks(snapshot(msg)))


async def _album_tracks_from_list(list_id: int, title: str):
    """Pulsa un álbum en la lista y lee sus canciones. Si el bot reemplazó o editó la lista,
    pulsa BACK en el álbum para recuperarla. Devuelve (datos, id_de_la_lista)."""
    opened, list_id = await click_in_list(list_id, title)
    album_msg = next((m for m in reversed(opened) if _has_tracks(m)), None)
    if not album_msg:
        return {"aviso": "El bot no mostró canciones para este álbum.", "respuesta": opened}, list_id
    pages = await all_pages(album_msg["message_id"], "Leyendo las canciones")
    parsed = _parse_album(pages)
    if not await _list_alive(list_id):
        report("Volviendo a la lista de álbumes")
        back = await press_nav(album_msg["message_id"], "back")
        lists = [m for m in back if m["buttons"] and not _has_tracks(m)]
        if lists:
            list_id = lists[-1]["message_id"]
    return parsed, list_id


async def album_tracks(artist: str, album: str, index: int = 0):
    """Canciones de un álbum concreto de un artista."""
    listing = await albums(artist, index)
    if "list_message_id" not in listing:
        return listing
    return {"artista": artist, "album": album,
            **(await _album_tracks_from_list(listing["list_message_id"], album))[0]}


async def discography(artist: str, index: int = 0):
    """Todos los álbumes del artista, cada uno con su lista de canciones."""
    listing = await albums(artist, index)
    if "list_message_id" not in listing:
        return listing
    list_id = listing["list_message_id"]
    result = {"artista": listing["artista"], "secciones": {}}
    for section, titles in listing["secciones"].items():
        result["secciones"][section] = []
        for title in titles:
            try:
                data, list_id = await _album_tracks_from_list(list_id, title)
            except Exception as e:  # un álbum que falle no debe tumbar todo el recorrido
                data = {"aviso": f"Error al abrir el álbum: {e}"}
            result["secciones"][section].append({"album": title, **data})
    return result


# --------------------------------------------------------------- Descargas ---

def _safe_name(name: str, fallback: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", (name or "").strip())
    return name or fallback


def _resolve_dir(out_dir: str) -> Path:
    path = Path(out_dir)
    if not path.is_absolute():
        path = ROOT / path  # 'downloads' = la carpeta compartida con la versión en Node
    path.mkdir(parents=True, exist_ok=True)
    return path


async def collect_get_all(message_id: int):
    """Pulsa el botón 'GET ALL' del álbum `message_id` y devuelve la lista de
    mensajes de audio (documentos) que envió el bot, sin descargarlos.

    El bot puede tardar en empezar a enviar (p. ej. si está ocupado) y puede hacer pausas
    entre archivos mientras los sube. Por eso no basta con que se quede callado unos segundos:
      - se espera hasta FILES_WAIT segundos a que llegue el primer archivo;
      - si la ficha dice cuántas pistas tiene ("Total tracks: N"), se sigue esperando mientras
        lleguen archivos, hasta tener las N o pasar FILES_GAP segundos sin ninguno nuevo."""
    client = await get_client()
    msg = await client.get_messages(BOT, ids=message_id)
    if not msg or not msg.buttons:
        raise ValueError(f"El mensaje {message_id} no existe o no tiene botones.")
    btn = find_button(msg, lambda t: bool(GET_ALL_RE.search(t)))
    if not btn:
        raise ValueError(f"El mensaje {message_id} no tiene botón 'GET ALL'.")
    m_total = TOTAL_TRACKS_RE.search(msg.message or "")
    expected = int(m_total.group(1)) if m_total else None
    report("Pidiendo las pistas al bot (GET ALL)")
    before = await last_id(client)
    await press(btn)
    loop = asyncio.get_running_loop()
    start = last_change = loop.time()
    docs: list = []
    while True:
        new = await wait_settled(client, before, watch_ids=[message_id])
        found = sorted((m for m in new if m.id > before and m.document), key=lambda m: m.id)
        now = loop.time()
        if len(found) != len(docs):
            docs, last_change = found, now
        if docs and (expected is None or len(docs) >= expected):
            break  # llegaron todas (o no sabemos cuántas son y el bot ya se calló)
        if docs and now - last_change >= FILES_GAP:
            break  # faltan pistas, pero el bot dejó de enviar: se baja lo que llegó
        if not docs and now - start >= FILES_WAIT:
            break  # el bot no mandó nada a tiempo
        if docs:
            report(f"Recibidas {len(docs)} de {expected} pistas del bot…")
        else:
            report(f"Esperando a que el bot envíe las pistas ({int(now - start)} s)…")
        await asyncio.sleep(1)
    return docs


async def download_get_all(message_id: int, out_dir: str = "downloads",
                           on_start=None, on_progress=None, on_file=None):
    """Pulsa el botón 'GET ALL' del álbum `message_id` y descarga sus pistas
    UNA A UNA (secuencial) para no saturar la red. Devuelve los metadatos y rutas.

    Callbacks opcionales (para interfaces con progreso):
      on_start(infos)                -> lista de metadatos, antes de descargar.
      on_progress(index, received, total) -> bytes recibidos de la pista `index`.
      on_file(index, path)           -> ruta local cuando termina cada pista."""
    folder = _resolve_dir(out_dir)
    audios = await collect_get_all(message_id)
    infos = [describe_media(m) or {} for m in audios]
    if on_start is not None:
        on_start(infos)
    files = []
    for i, m in enumerate(audios):  # bucle secuencial: nunca descarga varias pistas a la vez
        info = infos[i]
        target = folder / _safe_name(info.get("file_name"), f"{m.id}.bin")

        def _cb(received, total, i=i):
            if on_progress is not None:
                on_progress(i, received, total)

        path = await m.download_media(file=target, progress_callback=_cb if on_progress else None)
        if on_file is not None:
            on_file(i, str(path) if path else None)
        files.append({**info, "message_id": m.id,
                      "path": str(path) if path else None})
    return {"album_message_id": message_id, "total_pistas": len(files),
            "directorio": str(folder), "pistas": files}


async def _album_card_id(artist: str, album: str, index: int = 0):
    """Abre un álbum desde la lista del artista y devuelve el id del mensaje-ficha
    (el que contiene el botón 'GET ALL')."""
    listing = await albums(artist, index)
    if "list_message_id" not in listing:
        return None, listing
    opened, _ = await click_in_list(listing["list_message_id"], album)
    card = next((m for m in reversed(opened)
                 if any(GET_ALL_RE.search(b["text"]) for row in m["buttons"] for b in row)), None)
    if not card:
        return None, {"album": album, "respuesta": opened,
                      "error": "El bot no mostró el botón 'GET ALL' para este álbum."}
    return card["message_id"], None


def _has_get_all(msg) -> bool:
    return any(GET_ALL_RE.search(b["text"]) for row in msg["buttons"] for b in row)


async def album_card_in_list(list_id: int, title: str):
    """Para recorrer una discografía sin volver a buscar al artista en cada álbum:
    abre `title` desde una lista de álbumes ya abierta (en cualquier página) y devuelve
    (id de la ficha con 'GET ALL' o None, id de la lista, error o None)."""
    opened, list_id = await click_in_list(list_id, title)
    card = next((m for m in reversed(opened) if _has_get_all(m)), None)
    if not card:
        return None, list_id, "El bot no mostró el botón 'GET ALL' para este álbum."
    return card["message_id"], list_id, None


async def back_to_list(card_id: int, list_id: int) -> int:
    """Después de pedir un álbum, vuelve a la lista de álbumes (BACK) si el bot la reemplazó
    por la ficha. Devuelve el id del mensaje que muestra la lista (puede cambiar)."""
    client = await get_client()
    msg = await client.get_messages(BOT, ids=list_id)
    if msg and msg.buttons:
        snap = snapshot(msg)
        if not _has_tracks(snap) and not _has_get_all(snap):
            return list_id  # la lista sigue ahí
    report("Volviendo a la lista de álbumes")
    back = await press_nav(card_id, "back")
    lists = [m for m in back if m["buttons"] and not _has_tracks(m) and not _has_get_all(m)]
    if not lists:
        raise ValueError("El bot no volvió a la lista de álbumes.")
    return lists[-1]["message_id"]


async def download_album(artist: str, album: str, index: int = 0, out_dir: str = "downloads"):
    """Descarga las pistas de un álbum (artista + título) de forma secuencial."""
    card_id, error = await _album_card_id(artist, album, index)
    if card_id is None:
        return error
    result = await download_get_all(card_id, out_dir)
    result["album"] = album
    result["artista"] = artist
    return result


# ---------------------------------------------------------------------- MCP ---

def run_mcp():
    from mcp.server.fastmcp import FastMCP

    mcp = FastMCP("deezload")

    @mcp.tool()
    async def deezload_albums(artist: str, index: int = 0, raw: bool = False) -> str:
        """Devuelve la lista completa de álbumes de un artista según @deezload2bot.
        `index` elige cuál de los artistas encontrados usar (0 = el primero; si hay homónimos,
        consulta antes deezload_inline con '.art <nombre>' para ver la lista con número de álbumes).
        Devuelve los títulos agrupados por sección (Albums, Singles and EPs...). Con raw=true
        incluye también las páginas crudas del bot, por si la extracción necesita revisión."""
        return json.dumps(await albums(artist, index, raw), ensure_ascii=False, indent=2)

    @mcp.tool()
    async def deezload_album_tracks(artist: str, album: str, index: int = 0) -> str:
        """Lista de canciones (título, artista, duración) y fecha de un álbum concreto de un
        artista, según @deezload2bot. `album` debe ser uno de los títulos que devuelve
        deezload_albums."""
        return json.dumps(await album_tracks(artist, album, index), ensure_ascii=False, indent=2)

    @mcp.tool()
    async def deezload_discography(artist: str, index: int = 0) -> str:
        """Discografía completa de un artista según @deezload2bot: todos los álbumes (agrupados
        por sección) con la lista de canciones de cada uno. Tarda unos segundos por álbum."""
        return json.dumps(await discography(artist, index), ensure_ascii=False, indent=2)

    @mcp.tool()
    async def deezload_send(text: str) -> str:
        """Envía un mensaje a @deezload2bot desde la cuenta del usuario (por ejemplo, el nombre
        de un artista) y devuelve las respuestas del bot: texto y botones inline por fila.
        Para obtener la discografía: envía el nombre del artista, pulsa con deezload_click el
        botón del artista o de 'álbumes' si aparece, y recorre la paginación con deezload_all_pages."""
        return json.dumps(await send(text), ensure_ascii=False, indent=2)

    @mcp.tool()
    async def deezload_click(message_id: int, button_text: str) -> str:
        """Pulsa un botón inline de un mensaje de @deezload2bot (coincidencia exacta o parcial
        del texto del botón) y devuelve el estado resultante."""
        return json.dumps(await click(message_id, button_text), ensure_ascii=False, indent=2)

    @mcp.tool()
    async def deezload_all_pages(message_id: int) -> str:
        """Recorre todas las páginas de un mensaje paginado de @deezload2bot pulsando el botón
        de 'siguiente' hasta el final, y devuelve el texto y los botones de cada página."""
        return json.dumps(await all_pages(message_id), ensure_ascii=False, indent=2)

    @mcp.tool()
    async def deezload_inline(query: str) -> str:
        """Hace una consulta inline a @deezload2bot (lo mismo que escribir '@deezload2bot <query>'
        en Telegram) y devuelve todos los resultados con título y descripción, recorriendo
        la paginación. Úsala cuando un botón sea de tipo switchinline: query = inline_query
        del botón + el texto a buscar."""
        return json.dumps(await inline(query), ensure_ascii=False, indent=2)

    @mcp.tool()
    async def deezload_inline_pick(query: str, index: int = 0) -> str:
        """Elige el resultado número `index` (0 = primero, según deezload_inline) de una consulta
        inline a @deezload2bot, lo envía al chat con el bot como si se tocara en Telegram, y
        devuelve los mensajes resultantes con sus botones."""
        return json.dumps(await inline_pick(query, index), ensure_ascii=False, indent=2)

    @mcp.tool()
    async def deezload_get_all(message_id: int, out_dir: str = "downloads") -> str:
        """Pulsa el botón 'GET ALL' de un mensaje-ficha de álbum de @deezload2bot y descarga
        TODAS sus pistas como archivos de audio (FLAC) de forma SECUENCIAL (una a una, para no
        saturar la red). `message_id` es la ficha del álbum (la que tiene el botón GET ALL).
        Devuelve los metadatos y la ruta local de cada pista."""
        return json.dumps(await download_get_all(message_id, out_dir),
                          ensure_ascii=False, indent=2)

    @mcp.tool()
    async def deezload_download_album(artist: str, album: str, index: int = 0,
                                      out_dir: str = "downloads") -> str:
        """Descarga todas las pistas de un álbum concreto (artista + título) de @deezload2bot.
        Abre la ficha del álbum, pulsa 'GET ALL' y guarda los audios de forma SECUENCIAL."""
        return json.dumps(await download_album(artist, album, index, out_dir),
                          ensure_ascii=False, indent=2)

    mcp.run()


# ---------------------------------------------------------------------- CLI ---

async def _cli(args):
    # En Windows la consola/redirección usa cp1252 y no admite emojis: forzar UTF-8
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        if args[0] == "login":
            client = await get_client(interactive=True)
            me = await client.get_me()
            print(f"Sesión iniciada como {me.first_name} (@{me.username}).")
            return
        if args[0] == "send":
            out = await send(" ".join(args[1:]))
        elif args[0] == "click":
            out = await click(int(args[1]), " ".join(args[2:]))
        elif args[0] == "inline":
            out = await inline(" ".join(args[1:]))
        elif args[0] == "albums":
            rest = args[2:]
            raw = "--raw" in rest
            nums = [a for a in rest if a.isdigit()]
            out = await albums(args[1], int(nums[0]) if nums else 0, raw)
        elif args[0] == "album":
            out = await album_view(args[1], args[2], int(args[3]) if len(args) > 3 else 0)
        elif args[0] == "tracks":
            out = await album_tracks(args[1], args[2], int(args[3]) if len(args) > 3 else 0)
        elif args[0] == "discography":
            out = await discography(args[1], int(args[2]) if len(args) > 2 else 0)
        elif args[0] == "pick":
            out = await inline_pick(args[1], int(args[2]) if len(args) > 2 else 0)
        elif args[0] == "pages":
            out = await all_pages(int(args[1]))
        elif args[0] == "getall":
            out = await download_get_all(int(args[1]), args[2] if len(args) > 2 else "downloads")
        elif args[0] == "download":
            out = await download_album(args[1], args[2],
                                       int(args[3]) if len(args) > 3 else 0,
                                       args[4] if len(args) > 4 else "downloads")
        else:
            print(__doc__)
            return
        print(json.dumps(out, ensure_ascii=False, indent=2))
    finally:
        if _client is not None:
            await _client.disconnect()


if __name__ == "__main__":
    if len(sys.argv) == 1:
        run_mcp()
    else:
        asyncio.run(_cli(sys.argv[1:]))
