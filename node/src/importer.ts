/**
 * Importar una lista de canciones pegada como texto:
 *  - una por línea, «Artista - Título» (sin artista también vale: se busca solo el título);
 *  - o un CSV con cabecera, como los que exporta Exportify de Spotify («Track Name»,
 *    «Artist Name(s)») u otros con columnas de título y artista.
 */
export interface Wanted { artista: string; titulo: string }

const TITLE_COL = /^(track name|track|title|t[ií]tulo|canci[oó]n|song|name|nombre)$/i;
const ARTIST_COL = /^(artist name\(s\)|artist names?|artists?|artista?s?|int[eé]rprete)$/i;

/** Campos de una línea CSV (con comillas: "a, b" y "" para una comilla). */
export function csvFields(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

export function parseList(text: string): { canciones: Wanted[]; no_entendidas: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const canciones: Wanted[] = [], bad: string[] = [];
  if (!lines.length) return { canciones, no_entendidas: bad };
  // ¿CSV? La primera línea es una cabecera con columnas de título y artista.
  const sep = [",", ";", "\t"].find((s) => lines[0].includes(s));
  const head = sep ? csvFields(lines[0], sep) : [];
  const ti = head.findIndex((h) => TITLE_COL.test(h)), ai = head.findIndex((h) => ARTIST_COL.test(h));
  if (sep && ti >= 0) {
    for (const line of lines.slice(1)) {
      const f = csvFields(line, sep);
      const titulo = f[ti] ?? "", artista = ai >= 0 ? (f[ai] ?? "").split(/\s*[,;]\s*/)[0] : "";   // varios artistas: el primero
      if (titulo) canciones.push({ artista, titulo }); else bad.push(line);
    }
    return { canciones, no_entendidas: bad };
  }
  for (const raw of lines) {
    const line = raw.replace(/^\d+\s*[.)-]\s+/, "");   // «1. Artista - Título»
    const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(line);
    if (m) canciones.push({ artista: m[1].trim(), titulo: m[2].trim() });
    else if (/\p{L}/u.test(line)) canciones.push({ artista: "", titulo: line });
    else bad.push(raw);
  }
  return { canciones, no_entendidas: bad };
}
