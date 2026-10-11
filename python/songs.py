"""
Reconocer si una canción ya está en la carpeta de descargas aunque el nombre del archivo
no sea idéntico. Los archivos se llaman "Artista - Título.ext" y la misma canción puede
llegar escrita distinto según el álbum o la edición:

    Callejon Sin Salida          = Callejón Sin Salida            (tildes)
    Demasiado Nina               = Demasiado Niña                 (ñ)
    Seguire Buscandola           = Seguire Buscandola (Album Version)   (etiqueta de versión)
    Su Mirada Loco Loco          = Su Mirada (Loco, Loco)         (signos)

Lo que sí distingue una canción se conserva: "Su Mirada" no es "Su Mirada Loco Loco", y
"(Live)", "(Remix)" o "(Acoustic)" siguen siendo canciones distintas.
"""
import os
import re
import unicodedata
from pathlib import Path

# Etiquetas que no cambian la canción: se quitan si van entre paréntesis/corchetes o tras " - "
NEUTRAL = (
    r"album version|album ver|version album|version del album|lp version|"
    r"original version|version original|original mix|"
    r"(?:\d{4} )?remaster(?:ed)?(?: version)?(?: \d{4})?|remasterizad[oa](?: \d{4})?|"
    r"explicit(?: version)?|clean(?: version)?"
)
_NEUTRAL_BRACKETS = re.compile(rf"[\(\[]\s*(?:{NEUTRAL})\s*[\)\]]")
_NEUTRAL_DASH = re.compile(rf"\s+-\s+(?:{NEUTRAL})\s*$")
_ARTIST_SPLIT = re.compile(r"\s*(?:,|&|;|/|\bfeat\.?|\bft\.?|\bfeaturing\b|\bcon\b|\bwith\b|\by\b|\bx\b)\s*")
IGNORED_SUFFIXES = {".part", ".tmp", ".crdownload"}


def _plain(text: str | None) -> str:
    """Sin tildes ni ñ, en minúsculas; '_' cuenta como espacio (así guarda el servidor ':' '?' ...)."""
    text = unicodedata.normalize("NFKD", (text or "").replace("_", " "))
    return "".join(c for c in text if not unicodedata.combining(c)).lower().strip()


def _words(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", text)).strip()


def title_key(title: str | None) -> str:
    t = _plain(title)
    t = _NEUTRAL_BRACKETS.sub(" ", t)
    t = _NEUTRAL_DASH.sub("", t)
    return _words(t)


def artist_key(artist: str | None) -> str:
    """Artista principal: 'Eddy Herrera feat. X' y 'Eddy Herrera, X' -> 'eddy herrera'."""
    first = _ARTIST_SPLIT.split(_plain(artist), maxsplit=1)[0]
    return _words(first)


def split_name(file_name: str) -> tuple[str, str] | None:
    """'Artista - Título.flac' -> ('Artista', 'Título'); None si no tiene ese formato."""
    artist, sep, title = Path(file_name).stem.partition(" - ")
    return (artist, title) if sep else None


def folder_index(folder: Path) -> dict[str, list[tuple[str, str]]]:
    """{clave del título: [(artista principal, nombre del archivo), ...]} de la carpeta."""
    index: dict[str, list[tuple[str, str]]] = {}
    try:
        entries = list(os.scandir(folder))
    except OSError:
        return index
    for entry in entries:
        if not entry.is_file() or Path(entry.name).suffix.lower() in IGNORED_SUFFIXES:
            continue
        parts = split_name(entry.name)
        if parts:
            index.setdefault(title_key(parts[1]), []).append((artist_key(parts[0]), entry.name))
    return index


def find(index: dict, title: str | None, artists: list[str | None]) -> str | None:
    """Nombre del archivo de la carpeta que es la misma canción, o None.
    `artists`: artistas aceptables (el de la canción y el del álbum, por ejemplo)."""
    wanted = {artist_key(a) for a in artists if a}
    wanted.discard("")
    for artist, name in index.get(title_key(title), []):
        if artist in wanted:
            return name
    return None
