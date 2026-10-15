/**
 * Reconocer si una canción ya está en la carpeta aunque el nombre no sea idéntico.
 * Los archivos se llaman "Artista - Título.ext":
 *   Callejon Sin Salida  = Callejón Sin Salida               (tildes)
 *   Demasiado Nina       = Demasiado Niña                    (ñ)
 *   Seguire Buscandola   = Seguire Buscandola (Album Version) (etiqueta de versión)
 *   Su Mirada Loco Loco  = Su Mirada (Loco, Loco)            (signos)
 * Lo que distingue una canción se conserva: "(Live)", "(Remix)"…
 */
import { closeSync, openSync, readdirSync, readSync } from "node:fs";
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

/** Nombre del archivo de la carpeta que es la misma canción, o null. Si hay varios (p. ej. la
 *  versión explícita y la limpia), el primero que cumpla `prefer`. */
export function find(index: FolderIndex, title: string | undefined | null, artists: (string | undefined | null)[],
                     prefer: (name: string) => boolean = () => true): string | null {
  const wanted = new Set(artists.filter(Boolean).map((a) => artistKey(a)));
  wanted.delete("");
  const names = (index.get(titleKey(title)) || []).filter(([artist]) => wanted.has(artist)).map(([, name]) => name);
  return names.find(prefer) ?? names[0] ?? null;
}

/** Versión de un FLAC según su etiqueta ITUNESADVISORY (la escribe el bot): true explícita,
 *  false limpia, null si no se sabe (no es FLAC, no tiene la etiqueta o no se puede leer). */
export function explicitOf(path: string): boolean | null {
  const v = flacTags(path)?.ITUNESADVISORY;
  return v === undefined ? null : v.startsWith("1");
}

/** Etiquetas de un FLAC (VORBIS_COMMENT), con la clave en mayúsculas ({ARTIST, ALBUM, TITLE,
 *  TRACKNUMBER…}; si se repite, la primera). null si no es FLAC o no se puede leer.
 *  Lee solo los bloques de metadatos del principio del archivo. */
export function flacTags(path: string): Record<string, string> | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const read = (pos: number, len: number) => { const b = Buffer.alloc(len); return b.subarray(0, readSync(fd!, b, 0, len, pos)); };
    if (read(0, 4).toString("latin1") !== "fLaC") return null;
    for (let pos = 4, last = false; !last;) {
      const h = read(pos, 4);
      if (h.length < 4) return {};
      last = (h[0] & 0x80) !== 0;
      const len = h.readUIntBE(1, 3);
      if ((h[0] & 0x7f) === 4) {   // VORBIS_COMMENT: proveedor, número de comentarios y "CLAVE=valor" (UTF-8)
        const b = read(pos + 4, len), tags: Record<string, string> = {};
        let p = 4 + b.readUInt32LE(0);
        const n = b.readUInt32LE(p);
        p += 4;
        for (let i = 0; i < n && p + 4 <= b.length; i++) {
          const l = b.readUInt32LE(p), text = b.subarray(p + 4, p + 4 + l).toString("utf8"), eq = text.indexOf("=");
          p += 4 + l;
          if (eq > 0) tags[text.slice(0, eq).toUpperCase()] ??= text.slice(eq + 1);
        }
        return tags;
      }
      pos += 4 + len;
    }
    return {};
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
