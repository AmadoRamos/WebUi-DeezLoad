"""
Carátulas y datos de álbumes desde la API pública de Deezer (no necesita clave).

El bot muestra los datos de Deezer, así que los títulos de sus álbumes coinciden con los
de Deezer. Para no confundir artistas homónimos se elige el que tenga el mismo nombre y el
número de fans más parecido al que muestra la ficha del bot ("Fans on Deezer").

Nunca lanza errores hacia fuera: si Deezer no responde o no hay coincidencias, se devuelve
un resultado vacío y la interfaz usa sus portadas generadas y los datos del bot.
"""
import asyncio
import json
import re
import time
import unicodedata
import urllib.parse
import urllib.request

API = "https://api.deezer.com"
TIMEOUT = 8            # segundos por petición
MAX_PAGES = 5          # páginas de 100 álbumes por artista
CACHE_TTL = 6 * 3600   # estos datos casi nunca cambian

_cache: dict[str, tuple[float, dict]] = {}
_album_cache: dict[int, tuple[float, dict]] = {}


def _norm(text: str | None) -> str:
    """Minúsculas, sin tildes ni signos: 'Me Verás Volver (Hits & Más)' -> 'me veras volver hits mas'."""
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    text = re.sub(r"[^\w\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _base(text: str | None) -> str:
    """Título sin añadidos entre paréntesis o corchetes: '(Remastered)', '[Live]'..."""
    return _norm(re.sub(r"[\(\[][^\)\]]*[\)\]]", " ", text or ""))


def _get(path: str, **params) -> dict:
    url = path if path.startswith("http") else f"{API}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "deezload-web"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        data = json.loads(r.read().decode("utf-8"))
    if isinstance(data, dict) and "error" in data:  # Deezer responde 200 con {"error": {...}}
        err = data["error"]
        raise RuntimeError(err.get("message") if isinstance(err, dict) else str(err))
    return data


def _pick_artist(name: str, fans: int | None, results: list[dict]) -> dict | None:
    if not results:
        return None
    target = _norm(name)
    same = [a for a in results if _norm(a.get("name")) == target] or results
    if fans:
        return min(same, key=lambda a: abs((a.get("nb_fan") or 0) - fans))
    return same[0]


def _image(url: str | None) -> str | None:
    # Deezer usa una ruta vacía ('/cover//', '/artist//') cuando no hay imagen
    return url if url and "//250x250" not in url and not re.search(r"/(cover|artist)//", url) else None


def _album_entry(album: dict) -> dict:
    medium = _image(album.get("cover_medium"))
    return {
        "id": album.get("id"),
        "mediana": medium,
        "grande": (_image(album.get("cover_big")) or _image(album.get("cover_xl")) or medium) if medium else None,
        "fecha": album.get("release_date"),
        "tipo": album.get("record_type"),          # album | single | ep | compile
        "fans": album.get("fans"),
        "explicito": bool(album.get("explicit_lyrics")),
        "link": album.get("link"),
    }


def _lookup(name: str, fans: int | None) -> dict:
    key = f"{_norm(name)}|{fans or ''}"
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]
    artist = _pick_artist(name, fans, _get("/search/artist", q=name, limit=10).get("data", []))
    index = {"artista": None, "exacto": {}, "base": {}}
    if artist:
        index["artista"] = {
            "id": artist.get("id"), "nombre": artist.get("name"),
            "foto": _image(artist.get("picture_big")) or _image(artist.get("picture_medium")),
            "fans": artist.get("nb_fan"), "albumes": artist.get("nb_album"), "link": artist.get("link"),
        }
        url, pages = f"{API}/artist/{artist['id']}/albums?limit=100", 0
        while url and pages < MAX_PAGES:
            data = _get(url)
            for album in data.get("data", []):
                entry = _album_entry(album)
                index["exacto"].setdefault(_norm(album.get("title")), entry)
                index["base"].setdefault(_base(album.get("title")), entry)
            url, pages = data.get("next"), pages + 1
    _cache[key] = (time.time(), index)
    return index


async def find_covers(artist: str, albums: list[str], fans: int | None = None) -> dict:
    """Devuelve {"artista": {...} | None, "albumes": {titulo_del_bot: {mediana, grande, id,
    fecha, tipo, fans, explicito, link}}}. `mediana`/`grande` pueden ser None (sin carátula)."""
    try:
        index = await asyncio.to_thread(_lookup, artist, fans)
    except Exception as e:  # sin red, Deezer caído, cuota agotada...
        return {"artista": None, "albumes": {}, "error": str(e)}
    found = {}
    for title in albums:
        entry = index["exacto"].get(_norm(title)) or index["base"].get(_base(title))
        if entry:
            found[title] = entry
    return {"artista": index["artista"], "albumes": found}


def _album_details(album_id: int) -> dict:
    hit = _album_cache.get(album_id)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]
    a = _get(f"/album/{int(album_id)}")
    info = {
        "id": a.get("id"),
        "titulo": a.get("title"),
        "sello": a.get("label"),
        "generos": [g.get("name") for g in (a.get("genres") or {}).get("data", []) if g.get("name")],
        "pistas": a.get("nb_tracks"),
        "duracion": a.get("duration"),               # segundos
        "fans": a.get("fans"),
        "fecha": a.get("release_date"),
        "tipo": a.get("record_type"),
        "explicito": bool(a.get("explicit_lyrics")),
        "colaboradores": [c.get("name") for c in a.get("contributors") or [] if c.get("name")],
        "link": a.get("link"),
    }
    _album_cache[album_id] = (time.time(), info)
    return info


async def album_details(album_id: int) -> dict:
    """Sello, géneros, duración, fans... de un álbum de Deezer. Nunca lanza errores."""
    try:
        return await asyncio.to_thread(_album_details, album_id)
    except Exception as e:
        return {"id": album_id, "error": str(e)}
