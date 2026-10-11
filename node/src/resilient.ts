/**
 * Reintentos ante fallos pasajeros de Telegram (cortes de red, tiempos de espera, servidores
 * ocupados) y esperas que pide Telegram (FLOOD_WAIT). Envuelve un Transport sin cambiar lo que
 * hace: las operaciones que solo leen se repiten; las que actúan sobre el bot (pulsar un botón,
 * enviar la búsqueda) no, porque repetirlas podría hacerlas dos veces. De esas se encarga el Bot,
 * que mira si el bot reaccionó antes de volver a pulsar.
 */
import { report } from "./progress.js";
import type { Button, Msg, Transport } from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const text = (e: unknown) =>
  `${(e as { errorMessage?: string })?.errorMessage ?? ""} ${(e as Error)?.name ?? ""} ${(e as Error)?.message ?? String(e)}`;

/** Fallo de red o del servidor que suele arreglarse solo al reintentar. */
export function isTransient(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  if (code === -503 || code === 500 || code === -500) return true;
  return /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|socket hang up|network|disconnect|not connected|connection (closed|lost)|RPC_CALL_FAIL|RPC_MCGET_FAIL|INTERNAL|WORKER_BUSY|MSGID_DECREASE_RETRY|Request was unsuccessful/i.test(text(e));
}

/** Segundos que Telegram pide esperar (FLOOD_WAIT_X), o null si no es eso. */
export function floodSeconds(e: unknown): number | null {
  const s = (e as { seconds?: unknown })?.seconds;
  if (typeof s === "number" && /flood/i.test(text(e))) return s;
  const m = /FLOOD_(?:PREMIUM_)?WAIT_(\d+)/.exec(text(e));
  return m ? Number(m[1]) : null;
}

export interface ResilientOptions { retries: number; floodMax: number; baseDelayMs?: number }

export class ResilientTransport implements Transport {
  constructor(private t: Transport, private o: ResilientOptions) {}

  private async call<T>(what: string, fn: () => Promise<T>, retryTransient: boolean, onRetry?: () => void): Promise<T> {
    let tries = 0, floods = 0;
    for (;;) {
      try {
        return await fn();
      } catch (e) {
        const wait = floodSeconds(e);
        if (wait !== null && wait <= this.o.floodMax && floods++ < 3) {
          report(`Telegram pide esperar ${wait} s antes de seguir…`);
          await sleep((wait + 1) * 1000);
          onRetry?.();
          continue;
        }
        if (retryTransient && isTransient(e) && tries < this.o.retries) {
          tries++;
          report(`Fallo de conexión con Telegram al ${what}; reintentando (${tries}/${this.o.retries})…`);
          await sleep((this.o.baseDelayMs ?? 1000) * 2 ** (tries - 1));
          onRetry?.();
          continue;
        }
        throw e;
      }
    }
  }

  getMessages(ids: number[]) { return this.call("leer mensajes", () => this.t.getMessages(ids), true); }
  getSince(minId: number, limit: number) { return this.call("leer mensajes", () => this.t.getSince(minId, limit), true); }
  lastId() { return this.call("leer el chat", () => this.t.lastId(), true); }
  inlineQuery(q: string, offset?: string) { return this.call("buscar", () => this.t.inlineQuery(q, offset), true); }
  // Acciones sobre el bot: solo se repiten si Telegram pidió esperar (entonces no se hicieron).
  pressButton(msgId: number, b: Button) { return this.call("pulsar un botón", () => this.t.pressButton(msgId, b), false); }
  sendInlineResult(queryId: unknown, resultId: string) { return this.call("enviar la búsqueda", () => this.t.sendInlineResult(queryId, resultId), false); }
  sendMessage(text: string) { return this.call("enviar un mensaje", () => this.t.sendMessage(text), false); }
  /** Bajar un archivo sí se repite: cada intento lo empieza de cero. */
  download(msg: Msg, path: string, onProgress?: (r: number, t: number) => void) {
    return this.call("descargar", () => this.t.download(msg, path, onProgress), true, () => onProgress?.(0, 0));
  }
}
