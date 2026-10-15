/**
 * Carátulas y datos de álbumes desde la API pública de Deezer (no necesita clave).
 *
 * El bot muestra los datos de Deezer, así que los títulos de sus álbumes coinciden con los de
 * Deezer. Para no confundir artistas homónimos se elige el que tenga el mismo nombre y el número
 * de fans más parecido al que muestra la ficha del bot ("Fans on Deezer").
 *
 * Nunca lanza errores hacia fuera: si Deezer no responde o no hay coincidencias, se devuelve un
 * resultado vacío y la interfaz usa sus portadas generadas y los datos del bot.
 */
export const API = "https://api.deezer.com";
const TIMEOUT_MS = 8000;           // por petición
const MAX_PAGES = 5;               // páginas de 100 álbumes por artista
const CACHE_TTL_MS = 6 * 3600_000; // estos datos casi nunca cambian

type Json = Record<string, any>;
/** Hace la petición a Deezer. Se puede cambiar en las pruebas. */
export type Getter = (path: string, params?: Record<string, string | number>) => Promise<Json>;

/** Minúsculas, sin tildes ni signos: 'Me Verás Volver (Hits & Más)' -> 'me veras volver hits mas'. */
export function norm(text: string | null | undefined): string {
  return (text || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}_\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/** Título sin añadidos entre paréntesis o corchetes: '(Remastered)', '[Live]'… */
export function base(text: string | null | undefined): string {
  return norm((text || "").replace(/[([][^)\]]*[)\]]/g, " "));
}

export const realGet: Getter = async (path, params) => {
  let url = path.startsWith("http") ? path : `${API}${path}`;
  if (params && Object.keys(params).length)
    url += "?" + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const r = await fetch(url, { headers: { "User-Agent": "deezload-web" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = (await r.json()) as Json;
  if (data && typeof data === "object" && "error" in data) {  // Deezer responde 200 con {"error": {...}}
    const err = data.error;
    throw new Error(err && typeof err === "object" ? String(err.message) : String(err));
  }
  return data;
};

function pickArtist(name: string, fans: number | null | undefined, results: Json[]): Json | null {
  if (!results.length) return null;
  const target = norm(name);
  const same = results.filter((a) => norm(a.name) === target);
  const pool = same.length ? same : results;
  if (fans) return pool.reduce((best, a) => (Math.abs((a.nb_fan || 0) - fans) < Math.abs((best.nb_fan || 0) - fans) ? a : best));
  return pool[0];
}

/** Deezer usa una ruta vacía ('/cover//', '/artist//') cuando no hay imagen. */
export function image(url: string | null | undefined): string | null {
  return url && !url.includes("//250x250") && !/\/(cover|artist)\/\//.test(url) ? url : null;
}

function albumEntry(album: Json) {
  const medium = image(album.cover_medium);
  return {
    id: album.id ?? null,
    mediana: medium,
    grande: medium ? image(album.cover_big) || image(album.cover_xl) || medium : null,
    fecha: album.release_date ?? null,
    tipo: album.record_type ?? null,        // album | single | ep | compile
    fans: album.fans ?? null,
    explicito: !!album.explicit_lyrics,
    link: album.link ?? null,
  };
}
type Entry = ReturnType<typeof albumEntry>;
const artistEntry = (artist: Json) => ({
  id: artist.id ?? null, nombre: artist.name ?? null,
  foto: image(artist.picture_big) || image(artist.picture_medium),
  fans: artist.nb_fan ?? null, albumes: artist.nb_album ?? null, link: artist.link ?? null,
});
interface Index { artista: Json | null; exacto: Map<string, Entry>; base: Map<string, Entry> }

export class Covers {
  private cache = new Map<string, [number, Index]>();
  private albumCache = new Map<number, [number, Json]>();
  constructor(private get: Getter = realGet) {}

  private async lookup(name: string, fans: number | null | undefined): Promise<Index> {
    const key = `${norm(name)}|${fans || ""}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit[0] < CACHE_TTL_MS) return hit[1];
    const artist = pickArtist(name, fans, (await this.get("/search/artist", { q: name, limit: 10 })).data || []);
    const index: Index = { artista: null, exacto: new Map(), base: new Map() };
    if (artist) {
      index.artista = artistEntry(artist);
      for (const album of await this.rawAlbums(artist.id)) {
        const entry = albumEntry(album);
        const e = norm(album.title), b = base(album.title);
        if (!index.exacto.has(e)) index.exacto.set(e, entry);
        if (!index.base.has(b)) index.base.set(b, entry);
      }
    }
    this.cache.set(key, [Date.now(), index]);
    return index;
  }

  private async rawAlbums(artistId: number): Promise<Json[]> {
    const out: Json[] = [];
    let url: string | undefined = `${API}/artist/${artistId}/albums?limit=100`;
    for (let pages = 0; url && pages < MAX_PAGES; pages++) {
      const data = await this.get(url);
      out.push(...(data.data || []));
      url = data.next;
    }
    return out;
  }

  /** Los lanzamientos del artista `artistId` en Deezer, sin caché (para ver si hay alguno nuevo). */
  async albumsOf(artistId: number) {
    return (await this.rawAlbums(artistId)).map((a) => ({ ...albumEntry(a), titulo: String(a.title ?? "") }));
  }

  /** El artista de Deezer con ese nombre (el de fans más parecido, si se sabe), o null. Lanza si Deezer no responde. */
  async findArtist(name: string, fans?: number | null) {
    const artist = pickArtist(name, fans, (await this.get("/search/artist", { q: name, limit: 10 })).data || []);
    return artist ? artistEntry(artist) : null;
  }

  /** {artista: {...} | null, albumes: {título_del_bot: {id, mediana, grande, fecha, tipo, fans,
   *  explicito, link}}}. `mediana`/`grande` pueden ser null (sin carátula). */
  async findCovers(artist: string, albums: string[], fans?: number | null) {
    let index: Index;
    try { index = await this.lookup(artist, fans); }
    catch (e) { return { artista: null, albumes: {} as Record<string, Entry>, error: (e as Error).message || String(e) }; }  // sin red, Deezer caído…
    const found: Record<string, Entry> = {};
    for (const title of albums) {
      const entry = index.exacto.get(norm(title)) || index.base.get(base(title));
      if (entry) found[title] = entry;
    }
    return { artista: index.artista, albumes: found };
  }

  /** Sello, géneros, duración, fans… de un álbum de Deezer. Nunca lanza errores. */
  async albumDetails(albumId: number): Promise<Json> {
    const hit = this.albumCache.get(albumId);
    if (hit && Date.now() - hit[0] < CACHE_TTL_MS) return hit[1];
    try {
      const a = await this.get(`/album/${Math.trunc(albumId)}`);
      const info = {
        id: a.id ?? null,
        titulo: a.title ?? null,
        sello: a.label ?? null,
        generos: ((a.genres || {}).data || []).map((g: Json) => g.name).filter(Boolean),
        pistas: a.nb_tracks ?? null,
        duracion: a.duration ?? null,               // segundos
        fans: a.fans ?? null,
        fecha: a.release_date ?? null,
        tipo: a.record_type ?? null,
        explicito: !!a.explicit_lyrics,
        colaboradores: (a.contributors || []).map((c: Json) => c.name).filter(Boolean),
        link: a.link ?? null,
      };
      this.albumCache.set(albumId, [Date.now(), info]);
      return info;
    } catch (e) {
      return { id: albumId, error: (e as Error).message || String(e) };
    }
  }
}
