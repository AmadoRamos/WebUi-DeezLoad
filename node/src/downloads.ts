/**
 * Descargas:
 *  - turno único con el bot (buscar, abrir, GET ALL van de uno en uno) con registro de actividad;
 *  - cupos de descarga de archivos (1 = en secuencia, hasta 5), ajustables en caliente y por orden
 *    de pedido; se guardan en ajustes.json;
 *  - cada pista se baja a "nombre.part" y se renombra al terminar;
 *  - si la canción ya está en la carpeta (aunque el nombre no sea idéntico), no se vuelve a bajar;
 *  - si una pista falla, las demás siguen; un álbum que falló se puede reintentar.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { report, safeName, withProgress, type Bot } from "./bot.js";
import { cfg } from "./config.js";
import * as songs from "./songs.js";
import type { DocInfo, Msg, Transport } from "./types.js";

export const MAX_PARALLEL = 5;

// ------------------------------------------------------------------ Ajustes ---
/** Con qué versión quedarse si una canción tiene versión explícita y limpia
 *  ("cualquiera": la que ya tengas, sin volver a bajarla). */
export const VERSIONS = ["cualquiera", "explicita", "limpia"] as const;
export type Version = (typeof VERSIONS)[number];
/** Qué hacer con un disco nuevo de un artista que sigues. */
export const ON_RELEASE = ["avisar", "descargar"] as const;
export type OnRelease = (typeof ON_RELEASE)[number];
export interface Settings {
  descargas_simultaneas: number;
  version: Version;
  una_a_una_max: number;       // álbum a medias: hasta cuántas que faltan se piden una a una (si no, GET ALL)
  pausa_discografia: number;   // segundos de pausa entre álbumes de una discografía
  deseos_hora: number;         // hora (0-23) a la que se descarga «para después»; -1: solo a mano
  novedades: OnRelease;
}
/** Límites de los ajustes numéricos que se cambian desde la interfaz. */
export const LIMITS = { una_a_una_max: [0, 50], pausa_discografia: [0, 120], deseos_hora: [-1, 23] } as const;
export type NumberSetting = keyof typeof LIMITS;

/** Lee ajustes.json. Lo que falte o no valga toma el valor por defecto (el del .env). */
export function loadSettings(file: string, defaults: Partial<Pick<Settings, NumberSetting>> = {}): Settings {
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { /* no existe o está dañado */ }
  const n = data.descargas_simultaneas;
  return {
    descargas_simultaneas: Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_PARALLEL ? (n as number) : 1,
    version: VERSIONS.includes(data.version as Version) ? (data.version as Version) : "cualquiera",
    una_a_una_max: inRange(data.una_a_una_max, "una_a_una_max") ?? defaults.una_a_una_max ?? cfg.oneByOneMax,
    pausa_discografia: inRange(data.pausa_discografia, "pausa_discografia") ?? defaults.pausa_discografia ?? cfg.discPause,
    deseos_hora: inRange(data.deseos_hora, "deseos_hora") ?? -1,
    novedades: ON_RELEASE.includes(data.novedades as OnRelease) ? (data.novedades as OnRelease) : "avisar",
  };
}

function inRange(v: unknown, key: NumberSetting): number | null {
  const [min, max] = LIMITS[key];
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
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

/** De dónde salen las pistas si no es el álbum (artista + álbum). Se guarda en el historial para
 *  poder pedirlas otra vez tras reiniciar el servidor.
 *  cancion: el resultado `id` de la búsqueda `q`; pista: una canción de ese álbum (el título es
 *  `album` del trabajo); buscar: buscar la canción por título y artista (el trabajo) y elegir la
 *  primera que coincida (la de `album`, si se sabe). */
export type JobSource =
  | { tipo: "cancion"; q: string; id: string }
  | { tipo: "pista"; album: string; artistas: string[] }
  | { tipo: "buscar"; album?: string };

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
  /** Versión del álbum por su nombre: true explícito (🅴), false limpio, null sin saber. */
  albumVersion: boolean | null = null;
  discography: string | null = null;
  /** name: el nombre del artista que dio el bot (para la búsqueda directa), si se conoce. */
  constructor(public artist: string, public album: string, public index = 0, public name?: string) {}
  /** Cómo pedir las pistas, si no es buscar el álbum (p. ej. una canción suelta); también al reintentar. */
  getAudios?: GetAudios;
  source: JobSource | null = null;

  /** Un trabajo del historial (lo que guardó JSON.stringify). Si se cortó al cerrar el servidor,
   *  queda como fallido para reintentarlo. */
  static restore(d: Record<string, unknown>): DownloadJob {
    const job = Object.assign(new DownloadJob(String(d.artist ?? ""), String(d.album ?? "")), d) as DownloadJob;
    job.getAudios = undefined;
    jobSeq = Math.max(jobSeq, (Number(d.seq) || 0) + 1);
    if (job.status === "queued" || job.status === "running") {
      job.status = "error"; job.error = "Se cortó al cerrar el servidor."; job.step = null;
      job.finished = Date.now() / 1000;
    }
    return job;
  }

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

/** Versión de un álbum por su nombre: la lista de álbumes del bot marca los explícitos con 🅴
 *  («STANS (The Official Soundtrack) 🅴»). Con 🅴, explícito; sin 🅴 y con el nombre sacado de esa
 *  lista, limpio (un álbum no explícito no tiene canciones explícitas); si no, null: la búsqueda
 *  directa del bot no marca la versión. */
export function versionOfAlbum(title: string, fromList: boolean): boolean | null {
  return /🅴/u.test(title) ? true : fromList ? false : null;
}

export type GetAudios = (job: DownloadJob) => Promise<Msg[]>;

/** Una pista que ya está en la carpeta, como si el bot la hubiera enviado: al bajar se reconoce
 *  como "ya estaba" (por su nombre de archivo) y no se descarga. */
const fileYouHave = (file: string, title: string): Msg => ({
  id: 0, text: "", buttons: [], out: false, viaBot: false, editDate: 0, hasDocument: true,
  media: { kind: "document", file_name: file, title, size: 0 },
});

// ---------------------------------------------------------- Descargador ---
export class Downloader {
  jobs = new Map<string, DownloadJob>();
  settings: Settings;
  slots: FileSlots;
  queue: BotQueue;
  private fileLocks = new Map<string, Mutex>();

  constructor(
    private t: Transport,
    private bot: Pick<Bot, "albumCardId" | "collectGetAll" | "cardTracks" | "albumTrackFile">,
    public downloadsDir: string,
    private settingsFile: string,
    private notify: () => void = () => {},
    defaults: Partial<Pick<Settings, NumberSetting>> = {},   // si ajustes.json no los tiene (p. ej. DISC_PAUSE del servidor)
  ) {
    mkdirSync(downloadsDir, { recursive: true });
    this.settings = loadSettings(settingsFile, defaults);
    this.slots = new FileSlots(this.settings.descargas_simultaneas);
    this.queue = new BotQueue(notify);
  }

  /** Cambia cuántos archivos se bajan a la vez (se aplica también a lo que está en curso). */
  setParallel(n: number): { aviso?: string } {
    if (!Number.isInteger(n) || n < 1 || n > MAX_PARALLEL) throw new RangeError(`Elige un número entre 1 y ${MAX_PARALLEL}.`);
    this.settings.descargas_simultaneas = n;
    this.slots.setLimit(n);
    return this.persist();
  }

  /** Cambia un ajuste numérico (una a una, pausa de discografía, hora de «para después»); se aplica al momento. */
  setNumber(key: NumberSetting, n: number): { aviso?: string } {
    const [min, max] = LIMITS[key];
    if (!Number.isInteger(n) || n < min || n > max) throw new RangeError(`Elige un número entre ${min} y ${max}.`);
    this.settings[key] = n;
    return this.persist();
  }

  /** Cambia con qué versión quedarse (explícita / limpia / cualquiera). */
  setVersion(v: Version): { aviso?: string } {
    if (!VERSIONS.includes(v)) throw new RangeError(`Elige una de: ${VERSIONS.join(", ")}.`);
    this.settings.version = v;
    return this.persist();
  }

  /** Cambia qué hacer con un disco nuevo de un artista que sigues (avisar / descargarlo). */
  setOnRelease(v: OnRelease): { aviso?: string } {
    if (!ON_RELEASE.includes(v)) throw new RangeError(`Elige una de: ${ON_RELEASE.join(", ")}.`);
    this.settings.novedades = v;
    return this.persist();
  }

  private persist(): { aviso?: string } {
    this.notify();
    try { saveSettings(this.settingsFile, this.settings); }
    catch (e) { return { aviso: `Se aplicó, pero no se pudo guardar en ajustes.json: ${(e as Error).message}` }; }
    return {};
  }

  /** true explícita / false limpia / null cualquiera: la versión que se quiere. */
  private wanted(): boolean | null {
    return this.settings.version === "explicita" ? true : this.settings.version === "limpia" ? false : null;
  }

  /** ¿Vale el archivo `file` de la carpeta con la versión que se quiere? Si no se sabe su
   *  versión (no es FLAC o no tiene la etiqueta), sí: nunca se sustituye a ciegas. */
  keeps(file: string): boolean {
    const want = this.wanted();
    if (want === null) return true;
    const got = songs.explicitOf(join(this.downloadsDir, file));
    return got === null || got === want;
  }

  /** ¿Cuenta como "ya la tienes" en un álbum de versión `albumVersion` (ver versionOfAlbum)? Si
   *  el álbum es de la otra versión, no puede traer la que quieres: la que tienes vale. */
  counts(file: string, albumVersion: boolean | null): boolean {
    const want = this.wanted();
    return this.keeps(file) || (want !== null && albumVersion !== null && albumVersion !== want);
  }

  /** Pide las pistas de un álbum suelto: busca al artista, abre el álbum y pide las pistas. */
  private singleAudios: GetAudios = async (job) => {
    const [card, error] = await this.bot.albumCardId(job.artist, job.album, job.index, job.name);
    if (card === null) throw new Error(String((error as { error?: string })?.error || "No se encontró el álbum en el bot."));
    return this.cardAudios(card, job.albumVersion);
  };

  /** Pistas del álbum de la ficha `card`. Si ya tienes algunas (descarga parcial) y faltan como
   *  mucho `una_a_una_max` (ajustes; por defecto UNA_A_UNA_MAX), pide una a una
   *  solo las que faltan en lugar de GET ALL, y las que tienes ni se piden (salen como "ya
   *  estaba"); si las tienes todas, no se pide nada. Si no se puede (la ficha no muestra todas las
   *  canciones, una no se encuentra…), GET ALL como siempre: lo que ya está se salta al bajar. */
  async cardAudios(card: number, albumVersion: boolean | null = null): Promise<Msg[]> {
    const info = await this.bot.cardTracks(card);
    const index = songs.folderIndex(this.downloadsDir);
    // Solo cuenta como "ya la tienes" si es la versión que se quiere (explícita / limpia)
    const have = info?.pistas.map((p) => {
      const f = songs.find(index, p.titulo, [p.artista, info.artista], (n) => this.keeps(n));
      return f && this.counts(f, albumVersion) ? f : null;
    }) ?? [];
    const missing = have.filter((h) => !h).length;
    const max = this.settings.una_a_una_max;
    if (info && have.some(Boolean) && missing > max)
      report(`Faltan ${missing} canciones (más de ${max}): pidiendo el álbum completo (GET ALL)`);
    else if (info && have.some(Boolean)) {
      try {
        const out: Msg[] = [];
        let asked = 0;
        for (const [i, p] of info.pistas.entries()) {
          if (have[i]) { out.push(fileYouHave(have[i]!, p.titulo)); continue; }
          const step = `Pidiendo «${p.titulo}» al bot (${++asked} de ${missing} que faltan)`;
          report(step);
          out.push(...await this.bot.albumTrackFile([p.artista, info.artista], info.album, p.titulo, step));
        }
        return out;
      } catch (e) {
        report(`No se pudieron pedir una a una (${(e as Error).message}); pidiendo el álbum completo (GET ALL)`);
      }
    }
    return this.bot.collectGetAll(card);
  }

  /** Crea y lanza la descarga de un álbum. */
  start(artist: string, album: string, index = 0, getAudios?: GetAudios, name?: string, albumVersion: boolean | null = null,
        source: JobSource | null = null): DownloadJob {
    const job = new DownloadJob(artist.trim(), album.trim(), index, name?.trim() || undefined);
    job.getAudios = getAudios;
    job.source = source;
    job.albumVersion = albumVersion;
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
      const audios = await this.queue.run("descarga", job.album, () => (getAudios ?? job.getAudios ?? this.singleAudios)(job),
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
    const found = songs.find(songs.folderIndex(this.downloadsDir), title, [artist, info.performer], (f) => this.keeps(f));
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
        const markExisting = (file: string) => {
          const size = statSync(join(this.downloadsDir, file)).size;
          Object.assign(track, { status: "exists", file, path: join(this.downloadsDir, file), size, progress: size });
        };
        if (existing && this.counts(existing, job.albumVersion)) { markExisting(existing); return; }
        // Sin la canción, o con la otra versión (explícita / limpia): se baja. Si ya tenías la otra
        // versión, la que llega solo la sustituye si es la que quieres; si no, se descarta.
        let saved = target;
        await this.slots.acquire([job.seq, i]);
        try {
          track.status = "downloading";
          this.notify();
          await this.t.download(m, part, (received, total) => {
            track.progress = received;
            if (total) track.size = total;
            this.notify();
          });
          if (existing && songs.explicitOf(part) !== this.wanted()) saved = "";   // la misma versión que ya tenías
          else if (existing) renameSync(part, (saved = join(this.downloadsDir, existing)));   // sobrescribe la otra versión
          else renameSync(part, target);
        } finally {
          this.slots.release();
          if (existsSync(part)) { try { unlinkSync(part); } catch { /* descarga cortada: no dejar el temporal */ } }
        }
        if (!saved) { markExisting(existing!); return; }
        const size = statSync(saved).size;
        Object.assign(track, { status: "done", file: basename(saved), path: saved, size, progress: size });
      });
    } catch (e) {
      Object.assign(track, { status: "error", error: (e as Error).message || String(e), progress: 0 });
    } finally {
      this.notify();
    }
  }
}
