/**
 * Servidor web (port de webapp.py): mismas rutas, mismas respuestas y la misma interfaz (webui).
 *
 * Se arranca con `npm run web` (ver web.ts).
 * Sin dependencias extra: usa node:http. La conexión con Telegram se abre la primera vez que
 * hace falta, así que la página carga aunque la sesión no esté iniciada (el error sale al buscar).
 */
import { createReadStream } from "node:fs";
import { stat, statfs } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import type { Bot } from "./bot.js";
import { Covers } from "./covers.js";
import { Discography } from "./discography.js";
import { DownloadJob, Downloader, MAX_PARALLEL, Mutex } from "./downloads.js";
import * as songs from "./songs.js";
import type { Transport } from "./types.js";

export type BotApi = Pick<Bot, "artists" | "albums" | "albumTracks" | "albumCardId" | "albumCardDirect" | "albumCardInList" | "backToList" | "collectGetAll">;

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
// Mismas reglas que los modelos de FastAPI/pydantic de webapp.py (con mensajes en español).
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
  readonly discographies = new Map<string, Discography>();
  private discTurn = new Mutex();   // una discografía a la vez; las demás esperan su turno
  private version = 0;
  private waiters = new Set<() => void>();
  private streams = new Set<ServerResponse>();
  readonly server: Server;
  private batchMs: number;
  private pingMs: number;

  constructor(private o: AppOptions) {
    this.covers = o.covers ?? new Covers();
    this.downloader = new Downloader(o.transport, o.bot, o.downloadsDir, o.settingsFile, () => this.notify());
    this.batchMs = o.eventBatchMs ?? 300;
    this.pingMs = o.eventPingMs ?? 15_000;
    this.server = createServer((req, res) => { void this.handle(req, res); });
  }

  /** Hay algo nuevo que contar a la interfaz (descargas, actividad del bot o ajustes). */
  notify = () => {
    this.version++;
    const w = [...this.waiters];
    this.waiters.clear();
    w.forEach((f) => f());
  };

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
      return { job_id: dl.start(artist, album, index, undefined, str(b, "name", "")).id };
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
      return { existentes: tracks.flatMap((t, i) => (songs.find(index, t.titulo, [t.artista, artist]) ? [i] : [])) };
    }
    if (path === "/api/ajustes") {
      allow(method, "GET", "POST");
      if (method === "GET") return this.settingsOut();
      const n = int((await body()).descargas_simultaneas, "descargas_simultaneas");
      if (n < 1 || n > MAX_PARALLEL) throw new HttpError(422, `Elige un número entre 1 y ${MAX_PARALLEL}.`);
      const { aviso } = dl.setParallel(n);
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
      const disc = new Discography(artist.trim(), (name || artist).trim(), index, albums,
        { bot, downloader: dl, turn: this.discTurn, pauseSeconds: this.o.discPause, notify: this.notify });
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
    let sentActivity: string | null = null, sentSettings: string | null = null, sentDiscs: string | null = null;
    let seen = -1;
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
      const first = seen < 0;
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
