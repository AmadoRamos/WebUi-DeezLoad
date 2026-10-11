/**
 * Descarga de una discografía (port de la clase Discography de webapp.py): los álbumes elegidos
 * de un artista, de uno en uno y en orden estricto. Si un álbum falla se sigue con el siguiente
 * y se reintenta una vez al final. Se puede pausar, reanudar y cancelar entre álbumes.
 * Una discografía a la vez; las demás esperan su turno.
 */
import { randomUUID } from "node:crypto";
import type { Bot } from "./bot.js";
import { DownloadJob, Mutex, type Downloader } from "./downloads.js";
import * as songs from "./songs.js";
import type { Msg } from "./types.js";

/** Lo que la discografía necesita del bot (en las pruebas se usa un doble). */
export type DiscBot = Pick<Bot, "albums" | "albumCardDirect" | "albumCardInList" | "backToList" | "collectGetAll">;

export interface DiscAlbum {
  title: string; section: string;
  status: "pending" | "running" | "retry" | "completed" | "exists" | "error" | "canceled";
  job_id: string | null; error: string | null;
}

/** Como asyncio.Event: abierta deja pasar; cerrada hace esperar hasta que se abra. */
class Gate {
  private open = true;
  private waiters: (() => void)[] = [];
  isSet() { return this.open; }
  set() { this.open = true; this.waiters.splice(0).forEach((w) => w()); }
  clear() { this.open = false; }
  wait(): Promise<void> { return this.open ? Promise.resolve() : new Promise((r) => this.waiters.push(r)); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Discography {
  id = randomUUID().replace(/-/g, "").slice(0, 12);
  albums: DiscAlbum[];
  status: "queued" | "running" | "paused" | "completed" | "canceled" = "queued";
  cancelRequested = false;
  resume = new Gate();
  current: number | null = null;
  listId: number | null = null;   // lista de álbumes abierta en el bot (se reutiliza)
  created = Date.now() / 1000;
  finished: number | null = null;
  note: string | null = null;     // p. ej. "Pausa entre álbumes"

  constructor(
    public artist: string, public name: string, public index: number,
    albums: { title: string; section?: string }[],
    private ctx: { bot: DiscBot; downloader: Downloader; turn: Mutex; pauseSeconds: number; notify: () => void },
  ) {
    this.albums = albums.map((a) => ({ title: a.title, section: a.section || "", status: "pending", job_id: null, error: null }));
  }

  toDict() {
    const count = (st: DiscAlbum["status"]) => this.albums.filter((a) => a.status === st).length;
    return {
      id: this.id, artist: this.artist, name: this.name, status: this.status,
      cancelando: this.cancelRequested && (this.status === "running" || this.status === "paused"),
      pausando: !this.resume.isSet() && this.status === "running",
      created: this.created, finished: this.finished, current: this.current,
      nota: this.note, total: this.albums.length,
      listos: count("completed"), ya_estaban: count("exists"), con_error: count("error"),
      cancelados: count("canceled"), albums: this.albums,
    };
  }

  /** (artista|álbum) de lo que todavía va a descargar: para no pedirlo dos veces. */
  queuedKeys(): Set<string> {
    if (this.status === "completed" || this.status === "canceled") return new Set();
    const artist = songs.artistKey(this.artist);
    return new Set(this.albums.filter((a) => ["pending", "running", "retry"].includes(a.status))
      .map((a) => `${artist}|${songs.titleKey(a.title)}`));
  }

  /** Pide las pistas usando la lista de álbumes ya abierta: abrir el álbum, GET ALL y volver. */
  private audios = async (job: DownloadJob): Promise<Msg[]> => {
    const { bot } = this.ctx;
    // Primero la búsqueda directa (sin BACK ni páginas), con el nombre del artista que dio el bot.
    // Si no sirve, la lista de siempre (se abre solo cuando hace falta).
    // (con index > 0 solo si el nombre vino del bot: el texto escrito no distingue al artista)
    const direct = this.index && this.name === this.artist ? null : await bot.albumCardDirect(this.name, job.album);
    if (direct !== null) return bot.collectGetAll(direct);
    if (this.listId === null) {
      const listing = await bot.albums(this.artist, this.index) as { list_message_id?: number; error?: string };
      if (listing.list_message_id === undefined) throw new Error(listing.error || "El bot no mostró la lista de álbumes.");
      this.listId = listing.list_message_id;
    }
    let card: number | null, error: string | null;
    try {
      [card, this.listId, error] = await bot.albumCardInList(this.listId, job.album);
    } catch (e) {
      this.listId = null;  // se perdió la lista: el siguiente álbum la vuelve a abrir
      throw e;
    }
    if (card === null) throw new Error(error || "No se encontró el álbum en la lista.");
    const audios = await bot.collectGetAll(card);
    try { this.listId = await bot.backToList(card, this.listId!); } catch { this.listId = null; }
    return audios;
  };

  private async album(k: number, retry = false): Promise<boolean> {
    const { downloader, notify } = this.ctx;
    const album = this.albums[k];
    this.current = k; album.status = "running"; album.error = null;
    notify();
    let job = retry && album.job_id ? downloader.jobs.get(album.job_id) : undefined;
    if (job) job.resetForRetry();
    else {
      job = new DownloadJob(this.artist, album.title, this.index);
      job.discography = this.id;
      downloader.jobs.set(job.id, job);
      album.job_id = job.id;
    }
    notify();
    await downloader.runJob(job, this.audios);
    if (job.status === "completed") {
      album.status = job.tracks.length && job.tracks.every((t) => t.status === "exists") ? "exists" : "completed";
      return true;
    }
    album.status = "error"; album.error = job.error;
    return false;
  }

  /** Entre álbumes: espera si está en pausa; false si se canceló. */
  private async gate(): Promise<boolean> {
    if (!this.resume.isSet()) {
      this.status = "paused"; this.note = null;
      this.ctx.notify();
      await this.resume.wait();
    }
    if (this.cancelRequested) return false;
    this.status = "running";
    return true;
  }

  pause() { this.resume.clear(); if (this.status === "queued") this.status = "paused"; }
  continue() { this.resume.set(); if (this.status === "paused") this.status = this.current !== null ? "running" : "queued"; }
  cancel() { this.cancelRequested = true; this.resume.set(); }  // si estaba en pausa, que salga del bucle
  get ended() { return this.status === "completed" || this.status === "canceled"; }

  async run(): Promise<void> {
    const { turn, pauseSeconds, notify } = this.ctx;
    try {
      await turn.run(async () => {
        const failed: number[] = [];
        for (let k = 0; k < this.albums.length; k++) {
          if (!(await this.gate())) return;
          if (!(await this.album(k))) failed.push(k);
          if (k < this.albums.length - 1 && pauseSeconds > 0) {
            this.note = "Pausa entre álbumes";
            notify();
            await sleep(pauseSeconds * 1000);
            this.note = null;
          }
        }
        for (const k of failed) {  // un segundo intento para los que fallaron
          if (!(await this.gate())) return;
          this.albums[k].status = "retry";
          await this.album(k, true);
        }
      });
    } finally {
      for (const a of this.albums) if (a.status === "pending" || a.status === "retry") a.status = "canceled";
      this.status = this.cancelRequested ? "canceled" : "completed";
      this.current = null; this.note = null; this.finished = Date.now() / 1000;
      notify();
    }
  }
}
