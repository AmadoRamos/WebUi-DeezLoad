/**
 * Descargas (port de la parte de descargas de webapp.py):
 *  - turno único con el bot (buscar, abrir, GET ALL van de uno en uno) con registro de actividad;
 *  - cupos de descarga de archivos (1 = en secuencia, hasta 5), ajustables en caliente y por orden
 *    de pedido; se guardan en ajustes.json (el mismo archivo que usa la versión en Python);
 *  - cada pista se baja a "nombre.part" y se renombra al terminar;
 *  - si la canción ya está en la carpeta (aunque el nombre no sea idéntico), no se vuelve a bajar;
 *  - si una pista falla, las demás siguen; un álbum que falló se puede reintentar.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { safeName, withProgress, type Bot } from "./bot.js";
import * as songs from "./songs.js";
import type { DocInfo, Msg, Transport } from "./types.js";

export const MAX_PARALLEL = 5;

// ------------------------------------------------------------------ Ajustes ---
export interface Settings { descargas_simultaneas: number }

export function loadSettings(file: string): Settings {
  let n: unknown = 1;
  try { n = JSON.parse(readFileSync(file, "utf8")).descargas_simultaneas; } catch { /* no existe o está dañado */ }
  return { descargas_simultaneas: Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_PARALLEL ? (n as number) : 1 };
}

export function saveSettings(file: string, s: Settings): void {
  writeFileSync(file, JSON.stringify(s, null, 2), "utf8");
}

// --------------------------------------------------------------- Utilidades ---
/** Candado FIFO: quien llega primero, pasa primero. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

const cmp = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
};

/** Cupos para descargar archivos, con límite ajustable en caliente. Se conceden por prioridad:
 *  primero el álbum pedido antes y, dentro de él, la pista de menor número. */
export class FileSlots {
  active = 0;
  private waiting: { priority: number[]; seq: number; grant: () => void }[] = [];
  private seq = 0;
  constructor(public limit: number) {}

  setLimit(limit: number) {
    this.limit = limit;  // si baja, las descargas en curso terminan y no entran nuevas
    this.wake();
  }
  acquire(priority: number[]): Promise<void> {
    return new Promise((resolve) => {
      this.waiting.push({ priority, seq: this.seq++, grant: resolve });
      this.waiting.sort((a, b) => cmp(a.priority, b.priority) || a.seq - b.seq);
      this.wake();
    });
  }
  release() {
    this.active--;
    this.wake();
  }
  private wake() {
    while (this.active < this.limit && this.waiting.length) {
      const next = this.waiting.shift()!;
      this.active++;
      next.grant();
    }
  }
}

// ------------------------------------------------------- Turno con el bot ---
export interface Activity { id: string; tipo: string; titulo: string; estado: "esperando" | "en_curso"; paso: string | null; creado: number; inicio_paso: number }

/** Una operación con el bot a la vez; registra quién espera y en qué paso va quien tiene el turno. */
export class BotQueue {
  activity = new Map<string, Activity>();
  private lock = new Mutex();
  constructor(private notify: () => void = () => {}) {}

  run<T>(kind: string, title: string, fn: () => Promise<T>, onStep?: (step: string) => void): Promise<T> {
    const now = Date.now() / 1000;
    const op: Activity = { id: randomUUID().slice(0, 8), tipo: kind, titulo: title, estado: "esperando", paso: null, creado: now, inicio_paso: now };
    this.activity.set(op.id, op);
    this.notify();
    const step = (text: string) => {
      op.paso = text; op.inicio_paso = Date.now() / 1000;
      onStep?.(text);
      this.notify();
    };
    return this.lock.run(async () => {
      op.estado = "en_curso";
      step("Empezando…");
      return withProgress(step, fn);
    }).finally(() => { this.activity.delete(op.id); this.notify(); });
  }

  list(withSeconds = true) {
    const now = Date.now() / 1000;
    return [...this.activity.values()].sort((a, b) => a.creado - b.creado).map((op) => ({
      ...op, ...(withSeconds ? { segundos: Math.round(now - op.creado), segundos_paso: Math.round(now - op.inicio_paso) } : {}),
    }));
  }
}

// ---------------------------------------------------------- Trabajos ---
export interface TrackState {
  title: string; file_name: string | null; size: number; progress: number;
  status: "pending" | "downloading" | "done" | "exists" | "error";
  path: string | null; file: string | null; error?: string;
}

let jobSeq = 0;

export class DownloadJob {
  id = randomUUID().replace(/-/g, "").slice(0, 12);
  seq = jobSeq++;   // orden de llegada: decide qué álbum descarga primero
  status: "queued" | "running" | "completed" | "error" = "queued";
  error: string | null = null;
  tracks: TrackState[] = [];
  created = Date.now() / 1000;
  finished: number | null = null;
  step: string | null = null;   // paso actual mientras se preparan las pistas
  attempts = 1;
  discography: string | null = null;
  constructor(public artist: string, public album: string, public index = 0) {}

  /** Lo deja como nuevo para reintentarlo en su mismo lugar (lo ya guardado se salta). */
  resetForRetry() {
    this.seq = jobSeq++;
    this.status = "queued"; this.error = null; this.tracks = [];
    this.step = null; this.finished = null;
    this.attempts++;
  }

  toDict() {
    const done = this.tracks.filter((t) => t.status === "done" || t.status === "exists").length;
    return {
      id: this.id, artist: this.artist, album: this.album, status: this.status, error: this.error,
      paso: this.step, intentos: this.attempts, discografia: this.discography,
      created: this.created, finished: this.finished, total: this.tracks.length, done,
      existing: this.tracks.filter((t) => t.status === "exists").length,
      received: this.tracks.reduce((a, t) => a + (t.progress || 0), 0),
      size: this.tracks.reduce((a, t) => a + (t.size || 0), 0),
      tracks: this.tracks,
    };
  }
}

export type GetAudios = (job: DownloadJob) => Promise<Msg[]>;

// ---------------------------------------------------------- Descargador ---
export class Downloader {
  jobs = new Map<string, DownloadJob>();
  settings: Settings;
  slots: FileSlots;
  queue: BotQueue;
  private fileLocks = new Map<string, Mutex>();

  constructor(
    private t: Transport,
    private bot: Pick<Bot, "albumCardId" | "collectGetAll">,
    public downloadsDir: string,
    private settingsFile: string,
    private notify: () => void = () => {},
  ) {
    mkdirSync(downloadsDir, { recursive: true });
    this.settings = loadSettings(settingsFile);
    this.slots = new FileSlots(this.settings.descargas_simultaneas);
    this.queue = new BotQueue(notify);
  }

  /** Cambia cuántos archivos se bajan a la vez (se aplica también a lo que está en curso). */
  setParallel(n: number): { aviso?: string } {
    if (!Number.isInteger(n) || n < 1 || n > MAX_PARALLEL) throw new RangeError(`Elige un número entre 1 y ${MAX_PARALLEL}.`);
    this.settings.descargas_simultaneas = n;
    this.slots.setLimit(n);
    this.notify();
    try { saveSettings(this.settingsFile, this.settings); }
    catch (e) { return { aviso: `Se aplicó, pero no se pudo guardar en ajustes.json: ${(e as Error).message}` }; }
    return {};
  }

  /** Pide las pistas de un álbum suelto: busca al artista, abre el álbum y pulsa GET ALL. */
  private singleAudios: GetAudios = async (job) => {
    const [card, error] = await this.bot.albumCardId(job.artist, job.album, job.index);
    if (card === null) throw new Error(String((error as { error?: string })?.error || "No se encontró el álbum en el bot."));
    return this.bot.collectGetAll(card);
  };

  /** Crea y lanza la descarga de un álbum. */
  start(artist: string, album: string, index = 0, getAudios?: GetAudios): DownloadJob {
    const job = new DownloadJob(artist.trim(), album.trim(), index);
    this.jobs.set(job.id, job);
    this.notify();
    void this.runJob(job, getAudios);
    return job;
  }

  /** Reintenta una descarga que falló, en su mismo lugar. */
  retry(id: string, getAudios?: GetAudios): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw Object.assign(new Error("Esa descarga ya no existe. Pídela de nuevo desde el álbum."), { status: 404 });
    if (job.status !== "error") throw Object.assign(new Error("Solo se puede reintentar una descarga que falló."), { status: 409 });
    job.resetForRetry();
    this.notify();
    return this.runJob(job, getAudios);
  }

  async runJob(job: DownloadJob, getAudios?: GetAudios): Promise<void> {
    job.status = "running";
    this.notify();
    try {
      const audios = await this.queue.run("descarga", job.album, () => (getAudios ?? this.singleAudios)(job),
                                          (s) => { job.step = s; });
      job.step = null;
      if (!audios.length) throw new Error("El bot no envió pistas para este álbum.");
      const infos = audios.map((m) => (m.media?.kind === "document" ? (m.media as DocInfo) : ({} as Partial<DocInfo>)));
      job.tracks = infos.map((info, i) => ({
        title: info.title || info.file_name || `Pista ${i + 1}`, file_name: info.file_name ?? null,
        size: info.size || 0, progress: 0, status: "pending", path: null, file: null,
      }));
      // Aviso mientras se comprueba qué canciones ya están (suele ser al momento; tarda si la
      // misma canción se está bajando en otra descarga). Se quita cuando todas pasaron.
      let unchecked = job.tracks.length;
      job.step = "Comprobando qué canciones ya tienes en tu carpeta…";
      this.notify();
      const checked = () => { if (--unchecked === 0) { job.step = null; this.notify(); } };
      await Promise.all(audios.map((m, i) => this.fetchTrack(job, i, m, infos[i], checked)));
      const failed = job.tracks.filter((t) => t.status === "error");
      if (failed.length) {
        job.status = "error";
        job.error = `No se pudieron descargar ${failed.length} de ${job.tracks.length} pistas. Primer error: ${failed[0].error}`;
      } else job.status = "completed";
    } catch (e) {
      job.status = "error";
      job.error = (e as Error).message || String(e);
      job.step = null;
    } finally {
      job.finished = Date.now() / 1000;
      this.notify();
    }
  }

  /** (artista, título) de una pista: de 'Artista - Título.ext' o, si no, de sus etiquetas. */
  private songOf(info: Partial<DocInfo>, target: string): [string, string] {
    return songs.splitName(basename(target)) ?? [info.performer || "", info.title || basename(target)];
  }

  /** Archivo de la carpeta que ya es esta canción, o null si hay que bajarla. */
  findExisting(info: Partial<DocInfo>, target: string): string | null {
    const [artist, title] = this.songOf(info, target);
    const found = songs.find(songs.folderIndex(this.downloadsDir), title, [artist, info.performer]);
    if (found) return found;
    return existsSync(target) ? basename(target) : null;  // nombres sin el formato 'Artista - Título'
  }

  private async fetchTrack(job: DownloadJob, i: number, m: Msg, info: Partial<DocInfo>, checked = () => {}): Promise<void> {
    const track = job.tracks[i];
    const target = join(this.downloadsDir, safeName(info.file_name, `${m.id}.bin`));
    const part = `${target}.part`;
    // Un candado por canción (o por archivo si no es 'Artista - Título'): dos copias de la misma
    // canción nunca se bajan a la vez.
    const parts = songs.splitName(basename(target));
    const key = parts ? `${songs.artistKey(parts[0])}|${songs.titleKey(parts[1])}` : `archivo|${basename(target).toLowerCase()}`;
    if (!this.fileLocks.has(key)) this.fileLocks.set(key, new Mutex());
    try {
      await this.fileLocks.get(key)!.run(async () => {
        let existing: string | null;
        try { existing = this.findExisting(info, target); } finally { checked(); }
        if (existing) {
          const size = statSync(join(this.downloadsDir, existing)).size;
          Object.assign(track, { status: "exists", file: existing, path: join(this.downloadsDir, existing), size, progress: size });
          return;
        }
        await this.slots.acquire([job.seq, i]);
        try {
          track.status = "downloading";
          this.notify();
          await this.t.download(m, part, (received, total) => {
            track.progress = received;
            if (total) track.size = total;
            this.notify();
          });
          renameSync(part, target);
        } finally {
          this.slots.release();
          if (existsSync(part)) { try { unlinkSync(part); } catch { /* descarga cortada: no dejar el temporal */ } }
        }
        const size = statSync(target).size;
        Object.assign(track, { status: "done", file: basename(target), path: target, size, progress: size });
      });
    } catch (e) {
      Object.assign(track, { status: "error", error: (e as Error).message || String(e), progress: 0 });
    } finally {
      this.notify();
    }
  }
}
