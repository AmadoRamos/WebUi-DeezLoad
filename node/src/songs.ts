/**
 * Reconocer si una canción ya está en la carpeta aunque el nombre no sea idéntico
 * (port de songs.py). Los archivos se llaman "Artista - Título.ext":
 *   Callejon Sin Salida  = Callejón Sin Salida               (tildes)
 *   Demasiado Nina       = Demasiado Niña                    (ñ)
 *   Seguire Buscandola   = Seguire Buscandola (Album Version) (etiqueta de versión)
 *   Su Mirada Loco Loco  = Su Mirada (Loco, Loco)            (signos)
 * Lo que distingue una canción se conserva: "(Live)", "(Remix)"…
 */
import { readdirSync } from "node:fs";
import { extname, parse } from "node:path";

const NEUTRAL =
  "album version|album ver|version album|version del album|lp version|" +
  "original version|version original|original mix|" +
  "(?:\\d{4} )?remaster(?:ed)?(?: version)?(?: \\d{4})?|remasterizad[oa](?: \\d{4})?|" +
  "explicit(?: version)?|clean(?: version)?";
const NEUTRAL_BRACKETS = new RegExp(`[\\(\\[]\\s*(?:${NEUTRAL})\\s*[\\)\\]]`, "g");
const NEUTRAL_DASH = new RegExp(`\\s+-\\s+(?:${NEUTRAL})\\s*$`);
const ARTIST_SPLIT = /\s*(?:,|&|;|\/|\bfeat\.?|\bft\.?|\bfeaturing\b|\bcon\b|\bwith\b|\by\b|\bx\b)\s*/;
const IGNORED_SUFFIXES = new Set([".part", ".tmp", ".crdownload"]);

/** Sin tildes ni ñ, en minúsculas; '_' cuenta como espacio (así se guardan ':' '?' …). */
function plain(text: string | undefined | null): string {
  return (text || "").replace(/_/g, " ").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
}
const words = (t: string) => t.replace(/[^\p{L}\p{N}_\s]/gu, " ").replace(/\s+/g, " ").trim();

export function titleKey(title: string | undefined | null): string {
  return words(plain(title).replace(NEUTRAL_BRACKETS, " ").replace(NEUTRAL_DASH, ""));
}

/** Artista principal: 'Eddy Herrera feat. X' y 'Eddy Herrera, X' -> 'eddy herrera'. */
export function artistKey(artist: string | undefined | null): string {
  return words(plain(artist).split(ARTIST_SPLIT)[0] ?? "");
}

/** 'Artista - Título.flac' -> ['Artista', 'Título'] (null si no tiene ese formato). */
export function splitName(fileName: string): [string, string] | null {
  const stem = parse(fileName).name;
  const i = stem.indexOf(" - ");
  return i >= 0 ? [stem.slice(0, i), stem.slice(i + 3)] : null;
}

export type FolderIndex = Map<string, [string, string][]>;

/** {clave del título: [[artista principal, nombre del archivo], …]} de la carpeta. */
export function folderIndex(folder: string): FolderIndex {
  const index: FolderIndex = new Map();
  let entries;
  try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return index; }
  for (const e of entries) {
    if (!e.isFile() || IGNORED_SUFFIXES.has(extname(e.name).toLowerCase())) continue;
    const parts = splitName(e.name);
    if (!parts) continue;
    const k = titleKey(parts[1]);
    if (!index.has(k)) index.set(k, []);
    index.get(k)!.push([artistKey(parts[0]), e.name]);
  }
  return index;
}

/** Nombre del archivo de la carpeta que es la misma canción, o null. */
export function find(index: FolderIndex, title: string | undefined | null, artists: (string | undefined | null)[]): string | null {
  const wanted = new Set(artists.filter(Boolean).map((a) => artistKey(a)));
  wanted.delete("");
  for (const [artist, name] of index.get(titleKey(title)) || []) if (wanted.has(artist)) return name;
  return null;
}
