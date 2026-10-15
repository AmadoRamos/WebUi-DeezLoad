/**
 * Tu biblioteca: lo que hay en la carpeta de descargas, por artista y álbum.
 * El artista, el álbum y el número de pista salen de las etiquetas del FLAC; si no las tiene
 * (otro formato), del nombre "Artista - Título" y la canción queda como suelta.
 * Un álbum está incompleto si tiene menos canciones que su total: la etiqueta TRACKTOTAL o, si
 * no la tiene, el número de pistas que da Deezer (ver `checkDeezer`).
 */
import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { Covers } from "./covers.js";
import * as songs from "./songs.js";

const AUDIO = new Set([".flac", ".mp3", ".m4a", ".ogg", ".opus", ".wav", ".aac"]);

export interface LibSong { titulo: string; archivo: string; n: number | null; tamano: number }
export interface LibAlbum { album: string; canciones: LibSong[]; total: number | null; faltan: number; tamano: number }
export interface LibArtist { artista: string; albumes: LibAlbum[]; canciones: number; tamano: number }

interface FileInfo { artist: string; album: string; title: string; n: number | null; total: number | null }
const num = (v: string | undefined) => { const n = parseInt(v ?? "", 10); return Number.isFinite(n) && n > 0 ? n : null; };
const albumKey = (artist: string, album: string) => `${songs.artistKey(artist)}|${songs.titleKey(album)}`;

export class Library {
  /** archivo -> [tamaño y fecha, datos]: las etiquetas solo se vuelven a leer si el archivo cambió. */
  private files = new Map<string, [string, FileInfo]>();
  /** artista|álbum -> número de pistas en Deezer (para los álbumes sin TRACKTOTAL). */
  private deezerTotals = new Map<string, number | null>();

  constructor(private dir: string) {}

  private info(name: string, stamp: string): FileInfo {
    const hit = this.files.get(name);
    if (hit?.[0] === stamp) return hit[1];
    const tags = songs.flacTags(join(this.dir, name)) ?? {};
    const parts = songs.splitName(name);
    const tn = (tags.TRACKNUMBER ?? "").split("/");
    const info: FileInfo = {
      artist: tags.ALBUMARTIST || parts?.[0] || tags.ARTIST || "Sin artista",
      album: tags.ALBUM ?? "",
      title: tags.TITLE || parts?.[1] || name.replace(/\.[^.]+$/, ""),
      n: num(tn[0]),
      total: num(tags.TRACKTOTAL ?? tags.TOTALTRACKS ?? tn[1]),
    };
    this.files.set(name, [stamp, info]);
    return info;
  }

  /** Artistas (por orden alfabético) con sus álbumes; las canciones sin álbum van en uno sin nombre. */
  scan(): LibArtist[] {
    let entries;
    try { entries = readdirSync(this.dir, { withFileTypes: true }); } catch { return []; }
    const artists = new Map<string, LibArtist>(), albums = new Map<string, LibAlbum>();
    const seen = new Set<string>();
    for (const e of entries) {
      if (!e.isFile() || !AUDIO.has(extname(e.name).toLowerCase())) continue;
      let st;
      try { st = statSync(join(this.dir, e.name)); } catch { continue; }
      seen.add(e.name);
      const f = this.info(e.name, `${st.size}:${st.mtimeMs}`);
      const ak = songs.artistKey(f.artist) || f.artist.toLowerCase();
      let artist = artists.get(ak);
      if (!artist) artists.set(ak, (artist = { artista: f.artist, albumes: [], canciones: 0, tamano: 0 }));
      const key = albumKey(f.artist, f.album);
      let album = albums.get(key);
      if (!album) { albums.set(key, (album = { album: f.album, canciones: [], total: null, faltan: 0, tamano: 0 })); artist.albumes.push(album); }
      album.canciones.push({ titulo: f.title, archivo: e.name, n: f.n, tamano: st.size });
      if (f.total) album.total = Math.max(album.total ?? 0, f.total);
      album.tamano += st.size; artist.canciones++; artist.tamano += st.size;
    }
    for (const name of this.files.keys()) if (!seen.has(name)) this.files.delete(name);   // archivos borrados
    const byName = (a: string, b: string) => a.localeCompare(b, "es", { sensitivity: "base" });
    const out = [...artists.values()].sort((a, b) => byName(a.artista, b.artista));
    for (const artist of out) {
      for (const album of artist.albumes) {
        album.total ??= album.album ? this.deezerTotals.get(albumKey(artist.artista, album.album)) ?? null : null;
        album.faltan = album.total ? Math.max(0, album.total - album.canciones.length) : 0;
        album.canciones.sort((a, b) => (a.n ?? 999) - (b.n ?? 999) || byName(a.titulo, b.titulo));
      }
      artist.albumes.sort((a, b) => (!a.album ? 1 : !b.album ? -1 : byName(a.album, b.album)));   // las sueltas al final
    }
    return out;
  }

  /** Pregunta a Deezer cuántas pistas tienen los álbumes que no lo dicen en sus etiquetas.
   *  Devuelve cuántos se pudieron revisar. Los que Deezer no conoce quedan sin total. */
  async checkDeezer(covers: Covers): Promise<{ revisados: number; sin_datos: number }> {
    let revisados = 0, sinDatos = 0;
    for (const artist of this.scan()) {
      const pending = artist.albumes.filter((a) => a.album && !a.total && !this.deezerTotals.has(albumKey(artist.artista, a.album)));
      if (!pending.length) continue;
      const found = await covers.findCovers(artist.artista, pending.map((a) => a.album));
      for (const a of pending) {
        const id = found.albumes[a.album]?.id;
        const details = id ? await covers.albumDetails(id) : null;
        const total = typeof details?.pistas === "number" ? details.pistas : null;
        if (!("error" in found)) this.deezerTotals.set(albumKey(artist.artista, a.album), total);   // sin red: se reintenta otra vez
        if (total) revisados++; else sinDatos++;
      }
    }
    return { revisados, sin_datos: sinDatos };
  }
}
