/**
 * Servidor web: rutas de la API y la interfaz (webui).
 *
 * Se arranca con `npm run web` (ver web.ts).
 * Sin dependencias extra: usa node:http. La conexión con Telegram se abre la primera vez que
 * hace falta, así que la página carga aunque la sesión no esté iniciada (el error sale al buscar).
 */
import { createReadStream } from "node:fs";
import { stat, statfs } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import type { Bot } from "./bot.js";
import { Covers } from "./covers.js";
import { Library } from "./library.js";
import { parseList } from "./importer.js";
import { Releases, onePerTitle, type Release } from "./releases.js";
import { Wishlist, type Wish } from "./wishlist.js";
import { Discography, type DiscCtx } from "./discography.js";
import { DownloadJob, Downloader, LIMITS, MAX_PARALLEL, Mutex, ON_RELEASE, VERSIONS, versionOfAlbum,
         type GetAudios, type JobSource, type NumberSetting, type OnRelease, type Version } from "./downloads.js";
import * as songs from "./songs.js";
import { loadJson, saveJson } from "./store.js";
import type { Msg, Transport } from "./types.js";

/** Trabajos terminados que se guardan en el historial (los más recientes). */
const HISTORY_MAX = 300;
/** Cada cuánto se buscan discos nuevos de los artistas que sigues. */
const RELEASES_EVERY_S = 12 * 3600;
/** Canciones de una lista importada, como mucho. */
const IMPORT_MAX = 500;

export type BotApi = Pick<Bot, "cardTracks" | "albumTrackFile" | "albumSearch" | "songs" | "songFile" | "artists" | "albums" | "albumTracks" | "albumCardId" | "albumCardDirect" | "albumCardInList" | "backToList" | "collectGetAll">;

export interface AppOptions {
  transport: Transport;       // para bajar los archivos
  bot: BotApi;
  covers?: Covers;
  botName: string;
  downloadsDir: string;
  settingsFile: string;
  webui: string;              // carpeta con index.html
  discPause: number;          // segundos entre álbumes de una discografía
  eventBatchMs?: number;      // para agrupar ráfagas de cambios (el progreso llega muchas veces por segundo)
  eventPingMs?: number;       // sin cambios: señal para mantener viva la conexión
  log?: (line: string) => void;
}

class HttpError extends Error {
  constructor(public status: number, public detail: unknown) { super(typeof detail === "string" ? detail : "error"); }
}

// ------------------------------------------------- Validación de entradas ---
// Con mensajes en español.
type Body = Record<string, unknown>;
const bad = (msg: string) => new HttpError(422, msg);

function str(o: Body, key: string, def?: string): string {
  const v = o[key];
  if (v === undefined || v === null) { if (def !== undefined) return def; throw bad(`Falta '${key}'.`); }
  if (typeof v !== "string") throw bad(`'${key}' debe ser texto.`);
  return v;
}
function int(v: unknown, key: string, def?: number): number {
  if (v === undefined || v === null || v === "") { if (def !== undefined) return def; throw bad(`Falta '${key}'.`); }
  const n = typeof v === "string" && /^\s*-?\d+\s*$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) throw bad(`'${key}' debe ser un número entero.`);
  return n;
}
function list(o: Body, key: string, def?: unknown[]): unknown[] {
  const v = o[key];
  if (v === undefined || v === null) { if (def !== undefined) return def; throw bad(`Falta '${key}'.`); }
  if (!Array.isArray(v)) throw bad(`'${key}' debe ser una lista.`);
  return v;
}
const obj = (v: unknown, what: string): Body => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad(`${what} debe ser un objeto JSON.`);
  return v as Body;
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
  ".flac": "audio/flac", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/x-wav", ".ogg": "audio/ogg",
  ".opus": "audio/ogg", ".aac": "audio/aac", ".woff2": "font/woff2", ".woff": "font/woff",
};

export class App {
  readonly downloader: Downloader;
  readonly covers: Covers;
  readonly library: Library;
  readonly discographies = new Map<string, Discography>();
  private discTurn = new Mutex();   // una discografía a la vez; las demás esperan su turno
  private version = 0;
  private waiters = new Set<() => void>();
  private streams = new Set<ServerResponse>();
  readonly server: Server;
  private batchMs: number;
  private pingMs: number;
  private epoch = 0;                // cambia si se quitó algo (p. ej. limpiar el historial): se reenvía todo
  private historyFile: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private savedHistory = "";
  readonly wishlist: Wishlist;
  readonly releases: Releases;
  private clock: NodeJS.Timeout;
  private wishDay = "";             // día en que ya se descargó «para después» a su hora
  private checking: Promise<Release[]> | null = null;

  constructor(private o: AppOptions) {
    this.covers = o.covers ?? new Covers();
    this.library = new Library(o.downloadsDir);
    this.downloader = new Downloader(o.transport, o.bot, o.downloadsDir, o.settingsFile, () => this.notify(),
                                     { pausa_discografia: o.discPause });   // DISC_PAUSE, si ajustes.json no la tiene
    this.batchMs = o.eventBatchMs ?? 300;
    this.pingMs = o.eventPingMs ?? 15_000;
    const data = dirname(o.settingsFile);   // historial, «para después» y artistas que sigues, junto a ajustes.json
    this.historyFile = join(data, "historial.json");
    this.wishlist = new Wishlist(join(data, "deseos.json"), this.notify);
    this.releases = new Releases(join(data, "seguidos.json"), this.notify);
    this.server = createServer((req, res) => { void this.handle(req, res); });
    this.restoreHistory();
    this.clock = setInterval(() => void this.tick(), 60_000).unref();
  }

  // ------------------------------------------------------- Tareas a su hora ---
  /** Cada minuto: «para después» a la hora de Ajustes (una vez al día) y, cada 12 h, buscar
   *  discos nuevos de los artistas que sigues. */
  async tick(now = new Date()) {
    const hour = this.downloader.settings.deseos_hora, day = now.toDateString();
    if (hour >= 0 && now.getHours() === hour && this.wishDay !== day && this.wishlist.items.length) {
      this.wishDay = day;
      this.startWishes(this.wishlist.take());
    }
    if (this.releases.data.artistas.length && now.getTime() / 1000 - this.releases.data.revisado > RELEASES_EVERY_S)
      await this.checkReleases().catch((e) => this.o.log?.(`No se pudieron buscar discos nuevos: ${(e as Error).message}`));
  }

  /** Busca discos nuevos (una búsqueda a la vez). Con «descargar» en Ajustes, se descargan solos
   *  (de las dos versiones de un disco, la que prefieres) y no quedan en novedades. */
  checkReleases(): Promise<Release[]> {
    return this.checking ??= (async () => {
      try {
        const found = await this.releases.check(this.covers);
        const s = this.downloader.settings;
        if (found.length && s.novedades === "descargar") {
          this.releases.take(found.map((r) => r.id));
          for (const r of onePerTitle(found, s.version)) this.downloader.start(r.artista, r.album, 0, undefined, r.artista);
        }
        return found;
      } finally { this.checking = null; }
    })();
  }

  private followView() {
    const { artistas, novedades, revisado } = this.releases.data;
    return { artistas: artistas.map(({ conocidos: _, ...a }) => a), novedades, revisado };
  }

  /** Lanza la descarga de lo apuntado para después. */
  private startWishes(items: Wish[]): string[] {
    return items.map((w) => (w.tipo === "album"
      ? this.downloader.start(w.artista, w.titulo, 0, undefined, w.nombre, versionOfAlbum(w.titulo, !!w.lista))
      : this.startSong(w.artista, w.titulo, { tipo: "buscar", album: w.album })).id);
  }

  /** Hay algo nuevo que contar a la interfaz (descargas, actividad del bot o ajustes). */
  notify = () => {
    this.version++;
    const w = [...this.waiters];
    this.waiters.clear();
    w.forEach((f) => f());
    // El historial se guarda como mucho cada 2 s (el progreso avisa muchas veces por segundo).
    this.saveTimer ??= setTimeout(() => { this.saveTimer = null; this.saveHistory(); }, 2000).unref();
  };

  // ------------------------------------------------------------- Historial ---
  /** historial.json: las descargas y discografías, para que sigan ahí tras reiniciar el servidor. */
  saveHistory() {
    const dl = this.downloader;
    const ended = (j: DownloadJob) => j.status === "completed" || j.status === "error";
    const old = [...dl.jobs.values()].filter(ended).sort((a, b) => b.created - a.created).slice(HISTORY_MAX);
    for (const j of old) dl.jobs.delete(j.id);
    const text = JSON.stringify({ jobs: [...dl.jobs.values()], discografias: [...this.discographies.values()].map((d) => d.save()) });
    if (text === this.savedHistory) return;
    try { saveJson(this.historyFile, JSON.parse(text)); this.savedHistory = text; }
    catch (e) { this.o.log?.(`No se pudo guardar el historial: ${(e as Error).message}`); }
  }

  /** Lee historial.json y retoma lo que se cortó al cerrar: las discografías siguen donde iban
   *  (en pausa si lo estaban) y las descargas sueltas se piden otra vez. */
  private restoreHistory() {
    const h = loadJson<{ jobs?: Record<string, unknown>[]; discografias?: ReturnType<Discography["save"]>[] }>(this.historyFile, {});
    const dl = this.downloader;
    const cut: DownloadJob[] = [];
    for (const d of h.jobs ?? []) {
      const job = DownloadJob.restore(d);
      if (job.status === "error" && d.status !== "error") cut.push(job);
      job.getAudios = this.audiosFor(job.source);
      dl.jobs.set(job.id, job);
    }
    for (const d of h.discografias ?? []) {
      const disc = Discography.restore(d, this.discCtx());
      this.discographies.set(disc.id, disc);
      if (!disc.ended) void disc.run();
    }
    for (const job of cut) if (!job.discography) void this.retryJob(job);
    this.savedHistory = JSON.stringify({ jobs: [...dl.jobs.values()], discografias: [...this.discographies.values()].map((d) => d.save()) });
  }

  /** Quita del historial lo terminado (las discografías en curso y sus álbumes se quedan). */
  private clearHistory() {
    const dl = this.downloader;
    const keep = new Set<string>();
    for (const [id, disc] of this.discographies) {
      if (disc.ended) this.discographies.delete(id);
      else keep.add(id);
    }
    for (const [id, job] of dl.jobs)
      if ((job.status === "completed" || job.status === "error") && !keep.has(job.discography ?? "")) dl.jobs.delete(id);
    this.epoch++;
    this.notify();
  }

  private discCtx(): DiscCtx {
    const dl = this.downloader;
    return { bot: this.o.bot, downloader: dl, turn: this.discTurn, get pauseSeconds() { return dl.settings.pausa_discografia; }, notify: this.notify };
  }

  /** Cómo pedir las pistas de un trabajo que no es un álbum (ver JobSource). */
  private audiosFor(s: JobSource | null): GetAudios | undefined {
    const { bot } = this.o;
    if (s?.tipo === "cancion") return () => bot.songFile(s.q, s.id);
    if (s?.tipo === "pista") return (job) => bot.albumTrackFile(s.artistas, s.album, job.album);
    if (s?.tipo === "buscar") return (job) => this.findSong(job.artist, job.album, s.album);
    return undefined;
  }

  /** Busca la canción en el bot por título y artista y pide su archivo: la primera que coincida
   *  (sin distinguir tildes ni "(Album Version)"), y si hay varias, la de ese álbum. */
  private async findSong(artist: string, title: string, album = ""): Promise<Msg[]> {
    const q = `${title} ${artist}`.trim();
    const found = (await this.o.bot.songs(q))
      .filter((s) => songs.titleKey(s.titulo) === songs.titleKey(title) && (!artist || songs.artistKey(s.artista) === songs.artistKey(artist)));
    const pick = found.find((s) => album && songs.titleKey(s.album) === songs.titleKey(album)) ?? found[0];
    if (!pick) throw new Error(`El bot no encontró «${title}»${artist ? ` de ${artist}` : ""}.`);
    return this.o.bot.songFile(q, pick.id);
  }

  /** Lanza la descarga de una canción suelta (se puede volver a pedir tras reiniciar). */
  startSong(artist: string, title: string, source: JobSource): DownloadJob {
    return this.downloader.start(artist, title, 0, this.audiosFor(source), undefined, null, source);
  }

  private settingsOut() {
    return { ...this.downloader.settings, maximo: MAX_PARALLEL, en_curso: this.downloader.slots.active };
  }

  // ------------------------------------------------------------------ Rutas ---
  private async route(method: string, path: string, q: URLSearchParams, req: IncomingMessage, res: ServerResponse): Promise<unknown> {
    const dl = this.downloader;
    const { bot } = this.o;
    const body = async () => obj(await readJson(req), "El cuerpo");
    let m: RegExpMatchArray | null;

    if (path === "/") {
      allow(method, "GET");
      return this.sendFile(req, res, join(this.o.webui, "index.html"));
    }
    if (path.startsWith("/files/")) {
      allow(method, "GET");
      return this.serveDownload(req, res, path.slice("/files/".length));
    }
    if (path === "/api/config") {
      allow(method, "GET");
      return { bot: this.o.botName, downloads_dir: this.o.downloadsDir };
    }
    if (path === "/api/albums") {
      allow(method, "GET");
      const artist = qstr(q, "artist"), index = int(q.get("index"), "index", 0);
      return this.botCall("buscar", artist.trim(), () => bot.albums(artist, index));
    }
    if (path === "/api/artistas") {   // solo la consulta inline: no espera turno con el bot
      allow(method, "GET");
      try { return await bot.artists(qstr(q, "q")); }
      catch (e) { throw new HttpError(502, (e as Error)?.message || String(e)); }
    }
    if (path === "/api/canciones") {   // solo la consulta inline: no espera turno con el bot
      allow(method, "GET");
      try { return await bot.songs(qstr(q, "q")); }
      catch (e) { throw new HttpError(502, (e as Error)?.message || String(e)); }
    }
    if (path === "/api/albumes") {     // álbumes por título, de cualquier artista (solo la consulta inline)
      allow(method, "GET");
      try { return await bot.albumSearch(qstr(q, "q")); }
      catch (e) { throw new HttpError(502, (e as Error)?.message || String(e)); }
    }
    if (path === "/api/cancion") {     // descarga una canción suelta: el bot envía su archivo al elegirla
      allow(method, "POST");
      const b = await body();
      const query = str(b, "q"), id = str(b, "id"), title = str(b, "titulo"), artist = str(b, "artista", "");
      return { job_id: this.startSong(artist, title, { tipo: "cancion", q: query, id }).id };
    }
    if (path === "/api/pista") {       // una canción de la ficha de un álbum
      allow(method, "POST");
      const b = await body();
      const album = str(b, "album"), title = str(b, "titulo");
      const albumArtist = (str(b, "name", "") || str(b, "artist")).trim(), trackArtist = str(b, "artista", "").trim();
      return { job_id: this.startSong(trackArtist || albumArtist, title, { tipo: "pista", album, artistas: [trackArtist, albumArtist] }).id };
    }
    if (path === "/api/tracks") {
      allow(method, "GET");
      const artist = qstr(q, "artist"), album = qstr(q, "album"), index = int(q.get("index"), "index", 0);
      const name = q.get("name")?.trim() || undefined;   // el nombre que dio el bot (búsqueda directa)
      return this.botCall("album", album.trim(), () => bot.albumTracks(artist, album, index, name));
    }
    if (path === "/api/download") {
      allow(method, "POST");
      const b = await body();
      const artist = str(b, "artist"), album = str(b, "album"), index = int(b.index, "index", 0);
      const key = `${songs.artistKey(artist)}|${songs.titleKey(album)}`;
      for (const disc of this.discographies.values())
        if (disc.queuedKeys().has(key))
          throw new HttpError(409, `«${album.trim()}» ya está en la cola de la discografía de ${disc.name}.`);
      // lista: el título viene de la lista de álbumes del bot (con 🅴 si es explícito)
      return { job_id: dl.start(artist, album, index, undefined, str(b, "name", ""), versionOfAlbum(album, b.lista === true)).id };
    }
    if (path === "/api/existentes") {
      allow(method, "POST");
      const b = await body();
      const artist = str(b, "artist");
      const tracks = list(b, "tracks").map((t, i) => {
        const o = obj(t, `tracks[${i}]`);
        return { titulo: str(o, "titulo"), artista: str(o, "artista", "") };
      });
      const index = songs.folderIndex(this.o.downloadsDir);
      // "ya la tienes" solo si es la versión que se quiere (explícita / limpia), o si el álbum es de
      // la otra versión y no puede traerla
      const albumVersion = typeof b.album === "string" ? versionOfAlbum(b.album, b.lista === true) : null;
      return { existentes: tracks.flatMap((t, i) => {
        const f = songs.find(index, t.titulo, [t.artista, artist], (n) => dl.keeps(n));
        return f && dl.counts(f, albumVersion) ? [i] : [];
      }) };
    }
    if (path === "/api/ajustes") {
      allow(method, "GET", "POST");
      if (method === "GET") return this.settingsOut();
      const b = await body();
      let aviso: string | undefined;
      if (b.version !== undefined) {   // con qué versión quedarse: explícita / limpia / cualquiera
        const v = str(b, "version") as Version;
        if (!VERSIONS.includes(v)) throw new HttpError(422, `'version' debe ser una de: ${VERSIONS.join(", ")}.`);
        ({ aviso } = dl.setVersion(v));
      }
      if (b.novedades !== undefined) {   // disco nuevo de un artista que sigues: avisar / descargar
        const v = str(b, "novedades") as OnRelease;
        if (!ON_RELEASE.includes(v)) throw new HttpError(422, `'novedades' debe ser una de: ${ON_RELEASE.join(", ")}.`);
        ({ aviso } = dl.setOnRelease(v));
      }
      for (const key of Object.keys(LIMITS) as NumberSetting[]) {   // una a una, pausa de discografía, hora de «para después»
        if (b[key] === undefined) continue;
        const n = int(b[key], key), [min, max] = LIMITS[key];
        if (n < min || n > max) throw new HttpError(422, `'${key}': elige un número entre ${min} y ${max}.`);
        ({ aviso } = dl.setNumber(key, n));
      }
      const others = b.version !== undefined || b.novedades !== undefined || Object.keys(LIMITS).some((k) => b[k] !== undefined);
      if (b.descargas_simultaneas !== undefined || !others) {
        const n = int(b.descargas_simultaneas, "descargas_simultaneas");
        if (n < 1 || n > MAX_PARALLEL) throw new HttpError(422, `Elige un número entre 1 y ${MAX_PARALLEL}.`);
        ({ aviso } = dl.setParallel(n));
      }
      return { ...this.settingsOut(), ...(aviso ? { aviso } : {}) };
    }
    if (path === "/api/covers") {
      allow(method, "POST");
      const b = await body();
      const albums = list(b, "albums", []).map((a) => { if (typeof a !== "string") throw bad("'albums' debe ser una lista de textos."); return a; });
      const fans = b.fans === undefined || b.fans === null ? null : int(b.fans, "fans");
      return this.covers.findCovers(str(b, "artist").trim(), albums, fans);
    }
    if ((m = path.match(/^\/api\/deezer\/album\/([^/]+)$/))) {
      allow(method, "GET");
      return this.covers.albumDetails(int(decodeURIComponent(m[1]), "album_id"));
    }
    if (path === "/api/estimacion") {
      allow(method, "POST");
      const ids = [...new Set(list(await body(), "ids").map((v) => int(v, "ids")))].slice(0, 200);
      const details = await Promise.all(ids.map((i) => this.covers.albumDetails(i)));
      let libre: number | null = null;
      try { const s = await statfs(this.o.downloadsDir); libre = s.bavail * s.bsize; } catch { /* sin datos */ }
      return {
        albumes: Object.fromEntries(details.filter((x) => !("error" in x)).map((x) => [String(x.id), { pistas: x.pistas ?? null, duracion: x.duracion ?? null }])),
        libre,
      };
    }
    if (path === "/api/biblioteca") {            // lo que hay en la carpeta, por artista y álbum
      allow(method, "GET");
      return this.library.scan();
    }
    if (path === "/api/biblioteca/revisar") {    // total de pistas en Deezer de los álbumes que no lo dicen
      allow(method, "POST");
      return this.library.checkDeezer(this.covers);
    }
    if (path === "/api/deseos") {                  // «para después»: verlos o apuntar uno
      allow(method, "GET", "POST");
      if (method === "GET") return this.wishlist.items;
      const b = await body();
      const tipo = str(b, "tipo");
      if (tipo !== "album" && tipo !== "cancion") throw bad("'tipo' debe ser 'album' o 'cancion'.");
      const opt = (k: string) => str(b, k, "").trim() || undefined;
      return this.wishlist.add({ tipo, artista: str(b, "artista").trim(), titulo: str(b, "titulo").trim(),
                                 ...(tipo === "album" ? { nombre: opt("nombre"), lista: b.lista === true } : { album: opt("album") }) });
    }
    if (path === "/api/deseos/accion") {           // descargar o quitar los elegidos (sin ids: todos)
      allow(method, "POST");
      const b = await body();
      const accion = str(b, "accion"), ids = b.ids === undefined ? undefined : list(b, "ids").map(String);
      if (accion !== "descargar" && accion !== "quitar") throw bad("'accion' debe ser 'descargar' o 'quitar'.");
      const items = this.wishlist.take(ids);
      return { jobs: accion === "descargar" ? this.startWishes(items) : [], quitados: items.length };
    }
    if (path === "/api/importar") {                // una lista de canciones: descargarlas o apuntarlas para después
      allow(method, "POST");
      const b = await body();
      const destino = str(b, "destino", "descargar");
      if (destino !== "descargar" && destino !== "deseos") throw bad("'destino' debe ser 'descargar' o 'deseos'.");
      const { canciones, no_entendidas } = parseList(str(b, "texto"));
      if (canciones.length > IMPORT_MAX) throw bad(`Son ${canciones.length} canciones: como mucho ${IMPORT_MAX} de una vez.`);
      const index = songs.folderIndex(this.o.downloadsDir), seen = new Set<string>();
      const nuevas: typeof canciones = [], tienes: typeof canciones = [];
      for (const c of canciones) {
        const k = `${songs.artistKey(c.artista)}|${songs.titleKey(c.titulo)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        (c.artista && songs.find(index, c.titulo, [c.artista], (n) => dl.keeps(n)) ? tienes : nuevas).push(c);
      }
      for (const c of nuevas)
        if (destino === "deseos") this.wishlist.add({ tipo: "cancion", artista: c.artista, titulo: c.titulo });
        else this.startSong(c.artista, c.titulo, { tipo: "buscar" });
      return { anadidas: nuevas.length, ya_tienes: tienes, repetidas: canciones.length - seen.size, no_entendidas };
    }
    if (path === "/api/seguidos") {                // artistas que sigues y sus discos nuevos
      allow(method, "GET", "POST");
      if (method === "POST") {
        const b = await body();
        const fans = b.fans === undefined || b.fans === null ? null : int(b.fans, "fans");
        try { await this.releases.follow(this.covers, str(b, "artista").trim(), fans); }
        catch (e) { throw new HttpError(502, (e as Error)?.message || String(e)); }
      }
      return this.followView();
    }
    if ((m = path.match(/^\/api\/seguidos\/(\d+)\/dejar$/))) {
      allow(method, "POST");
      this.releases.unfollow(Number(m[1]));
      return this.followView();
    }
    if (path === "/api/seguidos/revisar") {        // buscar discos nuevos ahora
      allow(method, "POST");
      const found = await this.checkReleases();
      return { ...this.followView(), encontrados: found.length };
    }
    if (path === "/api/novedades") {               // descargar, apuntar para después o descartar las elegidas
      allow(method, "POST");
      const b = await body();
      const accion = str(b, "accion"), ids = list(b, "ids").map((v) => int(v, "ids"));
      if (!["descargar", "despues", "descartar"].includes(accion)) throw bad("'accion' debe ser 'descargar', 'despues' o 'descartar'.");
      for (const r of this.releases.take(ids)) {
        if (accion === "descargar") dl.start(r.artista, r.album, 0, undefined, r.artista);
        else if (accion === "despues") this.wishlist.add({ tipo: "album", artista: r.artista, titulo: r.album, nombre: r.artista });
      }
      return this.followView();
    }
    if (path === "/api/actividad") {
      allow(method, "GET");
      return dl.queue.list();
    }
    if (path === "/api/eventos") {
      allow(method, "GET");
      return this.events(req, res);
    }
    if (path === "/api/jobs") {
      allow(method, "GET");
      return [...dl.jobs.values()].sort((a, b) => b.created - a.created).map((j) => j.toDict());
    }
    if (path === "/api/jobs/limpiar") {   // quita del historial lo que ya terminó
      allow(method, "POST");
      this.clearHistory();
      return { ok: true };
    }
    if ((m = path.match(/^\/api\/jobs\/([^/]+)\/reintentar$/))) {
      allow(method, "POST");
      const job = dl.jobs.get(decodeURIComponent(m[1]));
      if (!job) throw new HttpError(404, "Esa descarga ya no existe. Pídela de nuevo desde el álbum.");
      if (job.status !== "error") throw new HttpError(409, "Solo se puede reintentar una descarga que falló.");
      void this.retryJob(job);
      return { job_id: job.id };
    }
    if ((m = path.match(/^\/api\/jobs\/([^/]+)$/))) {
      allow(method, "GET");
      const job = dl.jobs.get(decodeURIComponent(m[1]));
      if (!job) throw new HttpError(404, "Trabajo no encontrado");
      return job.toDict();
    }
    if (path === "/api/discografias") {
      allow(method, "GET", "POST");
      if (method === "GET") return [...this.discographies.values()].sort((a, b) => b.created - a.created).map((x) => x.toDict());
      const b = await body();
      const artist = str(b, "artist"), name = str(b, "name", ""), index = int(b.index, "index", 0);
      const albums = list(b, "albums").map((a, i) => { const o = obj(a, `albums[${i}]`); return { title: str(o, "title"), section: str(o, "section", "") }; });
      if (!albums.length) throw new HttpError(422, "Elige al menos un lanzamiento.");
      const disc = new Discography(artist.trim(), (name || artist).trim(), index, albums, this.discCtx());
      this.discographies.set(disc.id, disc);
      this.notify();
      void disc.run();
      return { id: disc.id };
    }
    if ((m = path.match(/^\/api\/discografias\/([^/]+)\/(pausar|reanudar|cancelar)$/))) {
      allow(method, "POST");
      const disc = this.discographies.get(decodeURIComponent(m[1]));
      if (!disc) throw new HttpError(404, "Esa descarga de discografía ya no existe.");
      if (disc.ended) throw new HttpError(409, "Esa discografía ya terminó.");
      if (m[2] === "pausar") disc.pause();        // al terminar el álbum en curso
      else if (m[2] === "reanudar") disc.continue();
      else disc.cancel();                         // el álbum en curso termina y no se empiezan más
      this.notify();
      return disc.toDict();
    }
    throw new HttpError(404, "Not Found");
  }

  /** Una operación con el bot (espera su turno y queda en /api/actividad). Errores -> 502. */
  private async botCall<T>(kind: string, title: string, fn: () => Promise<T>): Promise<T> {
    try { return await this.downloader.queue.run(kind, title, fn); }
    catch (e) { throw new HttpError(502, (e as Error)?.message || String(e)); }
  }

  /** Reintento a mano: si el álbum es de una discografía, actualizar también su estado. */
  private async retryJob(job: DownloadJob) {
    await this.downloader.retry(job.id);
    const disc = this.discographies.get(job.discography || "");
    if (disc) {
      for (const a of disc.albums)
        if (a.job_id === job.id && job.status === "completed") {
          a.status = job.tracks.length && job.tracks.every((t) => t.status === "exists") ? "exists" : "completed";
          a.error = null;
        }
      this.notify();
    }
  }

  // ------------------------------------------------------- Avisos en vivo ---
  /** Server-Sent Events. Al conectar se envía 'estado' con todo; después, 'cambios' solo con lo
   *  que cambió: descargas modificadas, la actividad del bot, los ajustes o las discografías.
   *  Sin cambios no se envía nada salvo un ping cada 15 s. El navegador se reconecta solo. */
  private async events(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache",
                         "X-Accel-Buffering": "no", Connection: "keep-alive" });
    res.flushHeaders();
    this.streams.add(res);
    let closed = false;
    let wake: (() => void) | null = null;
    res.on("close", () => { closed = true; this.streams.delete(res); wake?.(); });
    const sentJobs = new Map<string, string>();
    let sentActivity: string | null = null, sentSettings: string | null = null, sentDiscs: string | null = null, sentCounts: string | null = null;
    let seen = -1;
    let sentEpoch = this.epoch;
    res.write("retry: 3000\n\n");   // si se corta, el navegador reintenta a los 3 s
    while (!closed) {
      if (seen >= 0) {  // tras el primer envío, esperar a que haya algo nuevo
        if (this.version === seen) {
          const changed = await new Promise<boolean>((done) => {
            const timer = setTimeout(() => { this.waiters.delete(onChange); done(false); }, this.pingMs);
            const onChange = () => { clearTimeout(timer); done(true); };
            this.waiters.add(onChange);
            wake = () => { clearTimeout(timer); this.waiters.delete(onChange); done(false); };
          });
          wake = null;
          if (closed) return;
          if (!changed) { res.write(": ping\n\n"); continue; }
        }
        await new Promise((r) => setTimeout(r, this.batchMs));
      }
      if (closed) return;
      const first = seen < 0 || sentEpoch !== this.epoch;   // tras quitar algo, todo de nuevo
      if (first) sentJobs.clear();
      sentEpoch = this.epoch;
      seen = this.version;
      const payload: Record<string, unknown> = { ahora: Date.now() / 1000 };
      const changedJobs = [];
      for (const job of this.downloader.jobs.values()) {
        const data = job.toDict();
        const text = JSON.stringify(data);
        if (sentJobs.get(job.id) !== text) { sentJobs.set(job.id, text); changedJobs.push(data); }
      }
      const act = this.downloader.queue.list(false);
      const actText = JSON.stringify(act);
      const setNow = { ...this.downloader.settings, maximo: MAX_PARALLEL };
      const setText = JSON.stringify(setNow);
      if (first || changedJobs.length) payload.jobs = changedJobs;
      if (first || actText !== sentActivity) { payload.actividad = act; sentActivity = actText; }
      if (first || setText !== sentSettings) { payload.ajustes = setNow; sentSettings = setText; }
      const discs = [...this.discographies.values()].map((x) => x.toDict());
      const discsText = JSON.stringify(discs);
      if (first || discsText !== sentDiscs) { payload.discografias = discs; sentDiscs = discsText; }
      // cuántos hay «para después» y discos nuevos (los números de la barra de arriba)
      const counts = { deseos: this.wishlist.items.length, novedades: this.releases.data.novedades.length };
      const countsText = JSON.stringify(counts);
      if (first || countsText !== sentCounts) { payload.contadores = counts; sentCounts = countsText; }
      if (Object.keys(payload).length > 1)
        res.write(`event: ${first ? "estado" : "cambios"}\ndata: ${JSON.stringify(payload)}\n\n`);
    }
  }

  // ------------------------------------------------------------- Archivos ---
  private async serveDownload(req: IncomingMessage, res: ServerResponse, rel: string) {
    let name: string;
    try { name = decodeURIComponent(rel); } catch { throw new HttpError(404, "Not Found"); }
    const root = resolve(this.o.downloadsDir);
    const file = resolve(root, name);
    if (!file.startsWith(root + sep) || name.includes("\0")) throw new HttpError(404, "Not Found");
    return this.sendFile(req, res, file);
  }

  /** Envía un archivo (con soporte de rangos, como StaticFiles). */
  private async sendFile(req: IncomingMessage, res: ServerResponse, file: string) {
    let st;
    try { st = await stat(file); } catch { throw new HttpError(404, "Not Found"); }
    if (!st.isFile()) throw new HttpError(404, "Not Found");
    const headers: Record<string, string | number> = {
      "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
      "Accept-Ranges": "bytes", "Last-Modified": st.mtime.toUTCString(),
    };
    let start = 0, end = st.size - 1, status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
    if (range && (range[1] || range[2])) {
      if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), end); }
      else start = Math.max(0, st.size - Number(range[2]));
      if (start > end || start >= st.size) {
        res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
        return void res.end();
      }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
    }
    headers["Content-Length"] = st.size ? end - start + 1 : 0;
    res.writeHead(status, headers);
    if (req.method === "HEAD" || !st.size) return void res.end();
    await new Promise<void>((done) => {
      createReadStream(file, { start, end }).on("error", () => { res.destroy(); done(); }).on("end", done).pipe(res);
    });
  }

  // -------------------------------------------------------------- Manejo ---
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url || "/", "http://x");
    const method = req.method === "HEAD" ? "GET" : req.method || "GET";
    let status = 200;
    try {
      const out = await this.route(method, url.pathname, url.searchParams, req, res);
      if (!res.headersSent) {
        const text = JSON.stringify(out ?? null);
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
        res.end(req.method === "HEAD" ? undefined : text);
      }
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, "Internal Server Error");
      if (!(e instanceof HttpError)) this.o.log?.(`Error en ${req.method} ${url.pathname}: ${(e as Error)?.stack || e}`);
      status = err.status;
      if (!res.headersSent) {
        const text = JSON.stringify({ detail: err.detail });
        res.writeHead(err.status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text),
                                    ...(err.status === 405 ? { Allow: String((err as HttpError & { allow?: string }).allow || "") } : {}) });
        res.end(text);
      } else res.destroy();
    }
    if (url.pathname !== "/api/eventos") this.o.log?.(`${req.socket.remoteAddress} - "${req.method} ${url.pathname}" ${status}`);
  }

  listen(port: number, host: string): Promise<void> {
    return new Promise((ok, fail) => {
      this.server.once("error", fail);
      this.server.listen(port, host, () => { this.server.off("error", fail); ok(); });
    });
  }

  /** Cierra rápido: las conexiones de /api/eventos no deben retrasar el cierre (Ctrl+C). */
  async close() {
    clearInterval(this.clock);
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.saveHistory();
    for (const r of this.streams) r.destroy();
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

function allow(method: string, ...methods: string[]) {
  if (!methods.includes(method)) throw Object.assign(new HttpError(405, "Method Not Allowed"), { allow: methods.join(", ") });
}

function qstr(q: URLSearchParams, key: string): string {
  const v = q.get(key);
  if (v === null) throw bad(`Falta '${key}'.`);
  return v;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 2_000_000) throw new HttpError(413, "La petición es demasiado grande.");
    chunks.push(c as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"); }
  catch { throw bad("El cuerpo no es JSON válido."); }
}
