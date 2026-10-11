/**
 * Conversación con @deezload2bot: buscar artistas, leer la lista de álbumes (con sus páginas),
 * abrir álbumes, leer canciones y pedir las pistas (GET ALL).
 *
 * Es el port de deezload_mcp.py: mismas reglas y mismos resultados. No sabe nada de Telegram
 * directamente; habla con un `Transport` (GramJS en uso real, un bot falso en las pruebas).
 */
import type { Config } from "./config.js";
import { report } from "./progress.js";
import { isTransient } from "./resilient.js";
import type { Button, DocInfo, Msg, Snapshot, Transport } from "./types.js";

export { report, withProgress } from "./progress.js";

// ----------------------------------------------------------- Botones de navegación ---
// Un botón de navegación es, como mucho, UNA palabra de navegación rodeada de símbolos
// ("Next »", "« Prev", "➡️", "🔙 BACK"), o solo flechas. Así "Quiero Más" o "Back in Black"
// no se toman por botones de página.
const NEXT_SYMBOLS = [..."»›→➡▶⏩"];
const PREV_SYMBOLS = [..."«‹←⬅◀⏪"];
const CLOSE_SYMBOLS = [..."❌✖🔙"];
const NAV_WORDS: Record<string, "next" | "prev" | "back"> = {
  next: "next", siguiente: "next", sig: "next",
  prev: "prev", previous: "prev", anterior: "prev", ant: "prev",
  back: "back", "atrás": "back", atras: "back", close: "back", cerrar: "back",
};
// Palabras que también son títulos habituales ("Más" de Alejandro Sanz, "Volver"...):
// solo cuentan como navegación si van con una flecha o símbolo.
const NAV_WORDS_WITH_SYMBOL: Record<string, "next" | "back"> = { "más": "next", mas: "next", more: "next", volver: "back" };
// Python: [^\w]*([^\W\d_]+\.?)?[^\w]*  (con \w de Unicode)
const NAV_SHAPE_RE = /^[^\p{L}\p{N}_]*(\p{L}+\.?)?[^\p{L}\p{N}_]*$/u;

const cpLen = (s: string) => [...s].length;  // longitud en caracteres, como len() de Python

export function navKind(text: string | undefined): "next" | "prev" | "back" | null {
  const t = (text || "").trim();
  if (!t || cpLen(t) > 15) return null;
  const m = NAV_SHAPE_RE.exec(t);
  if (!m) return null;
  const word = (m[1] || "").replace(/\.$/, "").toLowerCase();
  const hasSymbol = cpLen(word) < cpLen(t);
  if (word) return NAV_WORDS[word] ?? (hasSymbol ? NAV_WORDS_WITH_SYMBOL[word] ?? null : null);
  if (t.includes(">>") || NEXT_SYMBOLS.some((c) => t.includes(c))) return "next";
  if (t.includes("<<") || PREV_SYMBOLS.some((c) => t.includes(c))) return "prev";
  if (CLOSE_SYMBOLS.some((c) => t.includes(c))) return "back";
  return null;
}

// -------------------------------------------------------------------- Patrones ---
export const COUNTER_RE = /^\s*\d+\s*(\/|of|de)\s*\d+\s*$/i;
export const SEPARATOR_RE = /^[\s━─—_=·•\-]+$/;
export const SKIP_RE = /^[^\p{L}\p{N}]*(get all|descargar todo|download all)\b/iu;   // admite "⬇️ GET ALL"
export const GET_ALL_RE = /(get all|descargar todo|download all)/i;
export const TRACKS_RE = /(track|canciones|songs|tracklist)/i;
export const TRACK_RE = /^\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*\|\s*(.+?)\s*$/;
// Python: ^\W*\s*([A-Za-zÁÉÍÓÚáéíóúñ ]+?)\s*:\s*(.+)$
export const HEADER_RE = /^[^\p{L}\p{N}_]*\s*([A-Za-zÁÉÍÓÚáéíóúñ ]+?)\s*:\s*(.+)$/u;
export const TOTAL_TRACKS_RE = /total tracks\s*:\s*(\d+)/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function snapshot(m: Msg): Snapshot {
  const out: Snapshot = {
    message_id: m.id,
    text: m.text,
    buttons: m.buttons.map((row) => row.map((b) => {
      const d: Snapshot["buttons"][number][number] = { text: b.text, kind: b.kind };
      if (b.kind === "switch_inline") d.inline_query = b.query;
      if (b.kind === "url") d.url = b.url;
      return d;
    })),
  };
  if (m.media) out.media = m.media;
  return out;
}

const btnTexts = (s: Snapshot) => s.buttons.flat().map((b) => b.text);
export const hasTracks = (s: Snapshot) => btnTexts(s).some((t) => TRACK_RE.test(t));
export const hasGetAll = (s: Snapshot) => btnTexts(s).some((t) => GET_ALL_RE.test(t));

function findButton(m: Msg | undefined, match: (text: string) => boolean): Button | undefined {
  for (const row of m?.buttons || []) for (const b of row) if (match(b.text)) return b;
  return undefined;
}

// ------------------------------------------------------------------ Pantallas ---
/** Lo que el bot puede estar mostrando en un mensaje:
 *  - menu:  la ficha del artista (TOP 30, ALBUMS…);
 *  - list:  la lista de álbumes (o una página de ella);
 *  - album: la ficha de un álbum (canciones, GET ALL, BACK);
 *  - files: un archivo (pista);  empty: texto sin botones (p. ej. "cargando…"). */
export type Screen = "menu" | "list" | "album" | "files" | "empty";

/** Error en el recorrido por los menús del bot (respuesta inesperada o sin respuesta):
 *  se puede arreglar volviendo a intentarlo. */
export class BotFlowError extends Error {
  override name = "BotFlowError";
  /** false: el bot no respondió ni insistiendo; volver a empezar solo alargaría la espera. */
  constructor(message: string, readonly restart = true) { super(message); }
}

// El botón de la ficha del artista que abre la lista: "ALBUMS", "💽 Albums", "ALBUMS (22)"…
const ALBUMS_BTN_RE = /^[^\p{L}]*(albums?|álbum(?:es)?|albumes)[^\p{L}]*$/iu;
export const isAlbumsButton = (t: string) => ALBUMS_BTN_RE.test(t.trim());
const COUNTER_NUMS_RE = /(\d+)\s*(?:\/|of|de)\s*(\d+)/i;

type Shown = { text: string; buttons: { text: string }[][]; hasDocument?: boolean; media?: unknown };

/** ¿El texto es el de la ficha de un álbum ("💽 Album: …", "🎧 Total tracks: …")? */
const isAlbumText = (text: string) => albumTitleOf({ text, buttons: [] }) !== null || TOTAL_TRACKS_RE.test(text || "");

export function screenOf(m: Shown): Screen {
  const texts = m.buttons.flat().map((b) => b.text);
  if (!texts.length) return m.hasDocument || (m.media as { kind?: string } | undefined)?.kind === "document" ? "files" : "empty";
  // Ficha de un álbum: tiene canciones, o GET ALL con el texto de la ficha. GET ALL solo no
  // basta: la lista de álbumes del bot también tiene un GET ALL (descargar todo).
  if (texts.some((t) => TRACK_RE.test(t))) return "album";
  if (texts.some((t) => GET_ALL_RE.test(t)) && isAlbumText(m.text)) return "album";
  const paged = texts.some((t) => COUNTER_RE.test(t) || navKind(t) === "next" || navKind(t) === "prev");
  if (texts.some(isAlbumsButton) && !paged) return "menu";
  return "list";
}

/** Página actual y total según el contador del bot ("2/5", "2 de 5"), o null. */
export function counterOf(m: Shown): [number, number] | null {
  for (const t of m.buttons.flat().map((b) => b.text)) {
    if (!COUNTER_RE.test(t)) continue;
    const c = COUNTER_NUMS_RE.exec(t)!;
    return [Number(c[1]), Number(c[2])];
  }
  return null;
}

/** Título del álbum según la ficha ("💽 Album: Quiero Más"), o null si no lo dice. */
export function albumTitleOf(m: Shown): string | null {
  for (const line of (m.text || "").split(/\r?\n/)) {
    const h = HEADER_RE.exec(line);
    if (h && h[1].trim().toLowerCase() === "album") return h[2].trim();
  }
  return null;
}

const plain = (t: string) => t.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
  .replace(/(\.\.\.|…)\s*$/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** ¿La ficha abierta es la del álbum pedido? (si la ficha no dice el título, se da por buena;
 *  admite que el botón tenga el título recortado). */
export function sameAlbum(card: Shown, wanted: string): boolean {
  const got = albumTitleOf(card);
  if (!got) return true;
  const a = plain(got), b = plain(wanted);
  return !a || !b || a === b || a.startsWith(b) || b.startsWith(a);
}

const msgSig = (m: Msg) => JSON.stringify([m.editDate, m.text, m.buttons.map((r) => r.map((b) => b.text))]);

// ------------------------------------------------------------------ Secciones ---
export function parseSections(pages: Snapshot[], firstSection = "Albums"): Record<string, string[]> {
  const order: string[] = [firstSection];
  const sections = new Map<string, string[]>([[firstSection, []]]);
  let current = firstSection;
  const seen = new Set<string>();
  for (const page of pages) {
    for (const row of page.buttons) {
      const texts = row.map((b) => b.text.trim());
      if (texts.some((t) => SEPARATOR_RE.test(t))) {
        const header = texts.filter((t) => t && !SEPARATOR_RE.test(t));
        if (header.length) {
          current = header[0];
          if (!sections.has(current)) { sections.set(current, []); order.push(current); }
        }
        continue;
      }
      for (const t of texts) {
        if (!t || SEPARATOR_RE.test(t) || SKIP_RE.test(t) || COUNTER_RE.test(t) || navKind(t) || TRACK_RE.test(t)) continue;
        const key = `${current}\u0000${t}`;
        if (!seen.has(key)) { seen.add(key); sections.get(current)!.push(t); }
      }
    }
  }
  const out: Record<string, string[]> = {};
  for (const k of order) if (sections.get(k)!.length) out[k] = sections.get(k)!;
  return out;
}

export interface Track { n: number; titulo: string; artista: string; duracion: string }
export interface AlbumData { fecha?: string; pistas: Track[]; aviso?: string }

/** Ficha (fecha, nº de pistas) y canciones 'duración | Artista - Título'. */
export function parseAlbum(pages: Snapshot[]): AlbumData {
  const info: Record<string, string> = {};
  for (const line of (pages[0]?.text || "").split(/\r?\n/)) {
    const m = HEADER_RE.exec(line);
    if (m) info[m[1].trim().toLowerCase()] = m[2].trim();
  }
  const tracks: Track[] = [];
  for (const page of pages) for (const row of page.buttons) for (const b of row) {
    const m = TRACK_RE.exec(b.text);
    if (!m) continue;
    const [, duration, rest] = m;
    const i = rest.indexOf(" - ");
    let artist = i >= 0 ? rest.slice(0, i) : "";
    let title = i >= 0 ? rest.slice(i + 3) : "";
    if (!title) { artist = ""; title = rest; }
    tracks.push({ n: tracks.length + 1, titulo: title.trim(), artista: artist.trim(), duracion: duration });
  }
  const out: AlbumData = { fecha: info["date"], pistas: tracks };
  const expected = info["total tracks"];
  if (expected && /^\d+$/.test(expected) && Number(expected) !== tracks.length)
    out.aviso = `El bot indica ${expected} pistas y se leyeron ${tracks.length}.`;
  return out;
}

export function safeName(name: string | undefined, fallback: string): string {
  const n = (name || "").trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  return n || fallback;
}

// ===================================================================== Bot ===
interface Reply { msg: Msg; all: Msg[]; ok: boolean }

/** Una línea legible de un mensaje para el registro: id, pantalla, texto y botones. */
export function describeMsg(m: Msg): string {
  const first = (m.text || "").split(/\r?\n/).filter(Boolean).join(" · ").slice(0, 120);
  const rows = m.buttons.map((r) => r.map((b) => b.text).join(" | ")).join(" / ");
  const file = m.hasDocument ? ` archivo: ${(m.media as DocInfo | undefined)?.file_name ?? "?"}` : "";
  return `#${m.id} [${screenOf(m)}] "${first}"${rows ? ` botones: ${rows.slice(0, 600)}` : ""}${file}`;
}

export interface BotOptions {
  /** Recibe una línea por cada paso con el bot (qué se pulsó, qué respondió). */
  trace?: (line: string) => void;
}

export class Bot {
  constructor(private t: Transport, private c: Config, private o: BotOptions = {}) {}

  private log(line: string) {
    try { this.o.trace?.(line); } catch { /* el registro nunca debe romper la operación */ }
  }

  private async getMsg(id: number): Promise<Msg | undefined> {
    return (await this.t.getMessages([id]))[0];
  }

  /** Espera a que el bot deje de enviar/editar mensajes y los devuelve en orden. */
  async waitSettled(afterId: number, watchIds: number[] = [], maxMs = this.c.maxWait * 1000): Promise<Msg[]> {
    const start = Date.now();
    let lastSig: string | null = null, lastChange = start, msgs: Msg[] = [];
    while (Date.now() - start < maxMs) {
      const fresh = (await this.t.getSince(afterId, 50)).filter((m) => !m.out || m.viaBot);
      const watched = watchIds.length ? (await this.t.getMessages(watchIds)).filter((m): m is Msg => !!m) : [];
      const byId = new Map<number, Msg>();
      for (const m of [...watched, ...fresh]) byId.set(m.id, m);
      msgs = [...byId.values()].sort((a, b) => a.id - b.id);
      const sig = JSON.stringify(msgs.map((m) => [m.id, m.editDate, m.text, m.buttons.length]));
      const now = Date.now();
      if (sig !== lastSig) { lastSig = sig; lastChange = now; }
      else if (msgs.length && now - lastChange >= this.c.quietSeconds * 1000) break;
      await sleep(this.c.pollMs);
    }
    return msgs;
  }

  /** Pulsa un botón. Algunos bots no contestan el callback a tiempo pero el mensaje igual cambia;
   *  y si la red falla al pulsar, no se sabe si llegó: quien llama mira si el bot reaccionó. */
  private async press(msgId: number, b: Button): Promise<void> {
    this.log(`pulsa «${b.text}» en #${msgId}`);
    try {
      await this.t.pressButton(msgId, b);
    } catch (e) {
      const s = `${(e as Error)?.name || ""} ${(e as Error)?.message || e}`;
      if (!/timeout/i.test(s) && !isTransient(e)) throw e;
    }
  }

  /** Espera la respuesta a una acción: mensajes nuevos (id > before) o `watchId` editado.
   *  Devuelve el más reciente que cumpla `want`; si el bot respondió otra cosa (y no es un
   *  "cargando…" sin botones), lo devuelve con ok=false; si no reaccionó en `patienceMs`, null. */
  private async awaitReply(before: number, watchId: number | null, beforeSig: string,
                           want: (m: Msg) => boolean, patienceMs: number): Promise<Reply | null> {
    const start = Date.now();
    let wrongRounds = 0, warned = false;
    for (;;) {
      const left = Math.max(patienceMs - (Date.now() - start), this.c.quietSeconds * 1000 + this.c.pollMs);
      const all = await this.waitSettled(before, watchId === null ? [] : [watchId], Math.min(left, this.c.maxWait * 1000));
      const changed = all.filter((m) => m.id > before || (m.id === watchId && msgSig(m) !== beforeSig));
      const hit = [...changed].reverse().find(want);
      if (hit) { this.log(`  responde: ${describeMsg(hit)}`); return { msg: hit, all, ok: true }; }
      const last = changed.at(-1);
      const elapsed = Date.now() - start;
      const wrong = (m: Msg) => { this.log(`  responde OTRA COSA: ${describeMsg(m)}`); return { msg: m, all, ok: false }; };
      if (last && screenOf(last) !== "empty" && ++wrongRounds >= 2) return wrong(last);
      if (elapsed >= patienceMs) {
        if (last) return wrong(last);
        this.log(`  sin respuesta en ${Math.round(elapsed / 1000)} s`);
        return null;
      }
      if (!warned && elapsed >= this.c.quietSeconds * 2000) {   // el doble del silencio normal
        warned = true;
        report("El bot está tardando en responder…");
      }
      await sleep(this.c.pollMs);
    }
  }

  /** Pulsa el botón que cumpla `pick` y espera una respuesta que cumpla `want`. Si el bot no
   *  reacciona (nada nuevo ni editado), espera hasta slowWait s y vuelve a pulsar (hasta
   *  `retries` veces). Si responde otra cosa, la devuelve con ok=false para que quien llama se
   *  recupere (volver a la lista, abrir ALBUMS…). */
  private async pressAndWait(msgId: number, pick: (t: string) => boolean, want: (m: Msg) => boolean,
                             label: string, retries = this.c.retries, patienceMs = this.c.slowWait * 1000): Promise<Reply> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const msg = await this.getMsg(msgId);
      if (!msg) throw new BotFlowError(`El mensaje ${msgId} ya no existe (al ${label}).`);
      const btn = findButton(msg, pick);
      if (!btn) throw new BotFlowError(`El bot ya no muestra el botón para ${label}.`);
      if (attempt) report(`El bot no respondió; pulsando otra vez para ${label} (intento ${attempt + 1} de ${retries + 1})`);
      const beforeSig = msgSig(msg);   // antes de pulsar: el mensaje puede editarse en el acto
      const before = await this.t.lastId();
      await this.press(msgId, btn);
      const got = await this.awaitReply(before, msgId, beforeSig, want, patienceMs);
      if (got) return got;
    }
    throw new BotFlowError(`El bot no respondió al ${label}.`, false);
  }

  /** Repite toda la operación si el recorrido por los menús del bot falló (respuesta
   *  inesperada, sin respuesta…). Otros errores se devuelven tal cual. */
  private async withRetries<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof BotFlowError) || !e.restart || attempt >= this.c.retries) throw e;
        this.log(`ERROR: ${e.message} -> se empieza de nuevo`);
        report(`${e.message} Empezando de nuevo (intento ${attempt + 2} de ${this.c.retries + 1})…`);
        await sleep(Math.min(2000, this.c.pollMs * 2));
      }
    }
  }

  async send(text: string): Promise<Snapshot[]> {
    const sent = await this.t.sendMessage(text);
    return (await this.waitSettled(sent.id)).map(snapshot);
  }

  async click(messageId: number, buttonText: string): Promise<Snapshot[]> {
    const msg = await this.getMsg(messageId);
    if (!msg || !msg.buttons.length) throw new Error(`El mensaje ${messageId} no existe o no tiene botones.`);
    const needle = buttonText.trim().toLowerCase();
    const btn = findButton(msg, (t) => t.trim().toLowerCase() === needle) ?? findButton(msg, (t) => t.toLowerCase().includes(needle));
    if (!btn) throw new Error(`No hay botón que coincida con '${buttonText}'.`);
    if (btn.kind === "switch_inline") {
      return [{ inline_button: { text: btn.text, kind: btn.kind, inline_query: btn.query },
                hint: "Botón de búsqueda inline: usa deezload_inline con inline_query + el texto a buscar." } as unknown as Snapshot];
    }
    const before = await this.t.lastId();
    await this.press(messageId, btn);
    return (await this.waitSettled(before, [messageId])).map(snapshot);
  }

  // ------------------------------------------------------------------ Páginas ---
  /** Pasa de página. Devuelve el id del mensaje con la página nueva, o null si el bot no cambió
   *  nada. Si el contador dice que hay más páginas, insiste (espera más y vuelve a pulsar);
   *  si no hay contador, no insiste: algunos bots dejan la flecha en la última página. */
  private async turnPage(current: number, dir: "next" | "prev", kind: Screen, expectMore: boolean): Promise<number | null> {
    let r: Reply;
    try {
      r = await this.pressAndWait(current, (t) => navKind(t) === dir, (m) => screenOf(m) === kind, "pasar de página",
                                  expectMore ? this.c.retries : 0,
                                  expectMore ? this.c.slowWait * 1000 : Math.max(this.c.quietSeconds * 1000, 1000));
    } catch (e) {
      if (e instanceof BotFlowError && !expectMore) return null;
      throw e;
    }
    if (!r.ok) throw new BotFlowError(`Al pasar de página el bot mostró otra cosa (${screenOf(r.msg)}).`);
    return r.msg.id;
  }

  /** Sigue los botones de 'siguiente' y devuelve todas las páginas. Si el bot tiene contador
   *  ("2/5") y alguna página se saltó, vuelve hacia atrás a buscarla. */
  async allPages(messageId: number, what?: string): Promise<Snapshot[]> {
    const pages: Snapshot[] = [];
    const byNumber = new Map<number, Snapshot>();
    const seen = new Set<string>();
    let current = messageId, total: number | null = null, kind: Screen | null = null;
    const record = (msg: Msg): boolean => {
      const snap = snapshot(msg);
      const key = JSON.stringify([snap.text, snap.buttons]);
      if (seen.has(key)) return false;
      seen.add(key);
      pages.push(snap);
      this.log(`  página ${pages.length}: ${describeMsg(msg)}`);
      const cnt = counterOf(msg);
      if (cnt) { byNumber.set(cnt[0], snap); total = cnt[1]; }
      if (what) report(`${what}: página ${pages.length}${total ? ` de ${total}` : ""}`);
      return true;
    };
    for (let i = 0; i < this.c.maxPages; i++) {
      const msg = await this.getMsg(current);
      if (!msg) break;
      kind ??= screenOf(msg);
      if (!record(msg)) break;
      if (!findButton(msg, (t) => navKind(t) === "next")) break;
      const cnt = counterOf(msg);
      if (cnt && cnt[0] >= cnt[1]) break;                      // última página según el contador
      const next = await this.turnPage(current, "next", kind, !!cnt);
      if (next === null) break;
      current = next;
    }
    // Páginas que faltan según el contador (el bot avanzó dos de golpe): ir hacia atrás.
    if (total && byNumber.size && byNumber.size < total && kind) {
      if (what) report(`${what}: faltan ${total - byNumber.size} páginas; volviendo a buscarlas`);
      for (let i = 0; i < this.c.maxPages && byNumber.size < total; i++) {
        const msg = await this.getMsg(current);
        const cnt = msg && counterOf(msg);
        if (!msg || !cnt || cnt[0] <= 1 || !findButton(msg, (t) => navKind(t) === "prev")) break;
        const prev = await this.turnPage(current, "prev", kind, true);
        if (prev === null) break;
        current = prev;
        const m2 = await this.getMsg(current);
        if (m2) record(m2);
      }
    }
    if (total && byNumber.size === pages.length)               // en orden de página
      pages.sort((a, b) => counterOf(a)![0] - counterOf(b)![0]);
    return pages;
  }

  /** Consulta inline (@bot <query>) con todas sus páginas. */
  async inline(query: string) {
    const out: { title?: string; description?: string; type?: string; url?: string; id: string }[] = [];
    let offset: string | undefined;
    for (let i = 0; i < this.c.maxPages; i++) {
      const res = await this.t.inlineQuery(query, offset);
      for (const r of res.results) out.push({ title: r.title, description: r.description, type: r.type, url: r.url, id: r.id });
      offset = res.nextOffset;
      if (!offset || !res.results.length) break;
    }
    return out;
  }

  /** Envía el resultado nº `index` de una consulta inline. Devuelve el último id antes de enviarlo. */
  private async sendInlinePick(query: string, index: number): Promise<number> {
    let offset: string | undefined, seen = 0;
    for (let i = 0; i < this.c.maxPages; i++) {
      const res = await this.t.inlineQuery(query, offset);
      if (index < seen + res.results.length) {
        const before = await this.t.lastId();
        await this.t.sendInlineResult(res.queryId, res.results[index - seen].id);
        return before;
      }
      seen += res.results.length;
      offset = res.nextOffset;
      if (!offset || !res.results.length) break;
    }
    throw new Error(`La consulta inline solo tiene ${seen} resultados.`);
  }

  /** Elige el resultado nº `index` de una consulta inline (como tocarlo en Telegram). */
  async inlinePick(query: string, index = 0): Promise<Snapshot[]> {
    const before = await this.sendInlinePick(query, index);
    return (await this.waitSettled(before)).map(snapshot);
  }

  // ------------------------------------------------------------------- Artista ---
  /** Busca al artista y devuelve la ficha (o directamente la lista, si el bot la muestra).
   *  Si el bot tarda, espera; si no aparece la ficha, vuelve a buscar. */
  private async searchArtist(artist: string, index: number): Promise<Msg> {
    // Ficha: el menú del artista; si el bot usa otros nombres, cualquier mensaje con un botón de álbumes.
    const isCard = (m: Msg) => screenOf(m) === "menu" || screenOf(m) === "list"
      || (screenOf(m) !== "album" && m.buttons.flat().some((b) => /album/i.test(b.text)));
    for (let attempt = 0; attempt <= this.c.retries; attempt++) {
      if (attempt) report(`El bot no mostró la ficha de «${artist}»; buscando otra vez (intento ${attempt + 1} de ${this.c.retries + 1})`);
      this.log(`busca «${this.c.artistPrefix + artist}» (resultado ${index})`);
      const before = await this.sendInlinePick(this.c.artistPrefix + artist, index);
      const got = await this.awaitReply(before, null, "", isCard, this.c.slowWait * 1000);
      if (got?.ok) {
        // Si llegaron varias fichas (búsqueda repetida), la más reciente con botón de álbumes.
        return [...got.all].reverse().find((m) => m.id > before && screenOf(m) === "menu") ?? got.msg;
      }
    }
    throw new BotFlowError("El bot no mostró un botón de álbumes.", false);
  }

  /** Lleva a la lista de álbumes desde lo que esté mostrando el bot: desde la ficha del artista
   *  pulsa ALBUMS; desde la ficha de un álbum pulsa BACK (y si eso lleva al menú, ALBUMS). */
  async ensureList(startId: number): Promise<number> {
    let id = startId;
    for (let step = 0; step < 4; step++) {
      const m = await this.getMsg(id);
      if (!m) throw new BotFlowError("El mensaje con la lista de álbumes ya no existe.");
      const s = screenOf(m);
      if (s === "list") return id;
      const isList = (x: Msg) => screenOf(x) === "list";
      let r: Reply;
      if (s === "menu" || (s !== "album" && m.buttons.flat().some((b) => /album/i.test(b.text)))) {
        report("Abriendo la lista de álbumes");
        const pick = findButton(m, isAlbumsButton) ? isAlbumsButton : (t: string) => /album/i.test(t) && !navKind(t);
        r = await this.pressAndWait(id, pick, isList, "abrir la lista de álbumes");
      } else if (s === "album") {
        report("Volviendo a la lista de álbumes");
        r = await this.pressAndWait(id, (t) => navKind(t) === "back", (x) => isList(x) || screenOf(x) === "menu", "volver a la lista de álbumes");
      } else {
        throw new BotFlowError("El bot mostró un mensaje inesperado en lugar de la lista de álbumes.");
      }
      id = r.msg.id;
    }
    throw new BotFlowError("No se pudo llegar a la lista de álbumes.");
  }

  /** Nombre del artista -> búsqueda inline -> ficha -> ALBUMS -> todas las páginas. */
  private async albumsOnce(artist: string, index = 0, raw = false) {
    this.log(`=== Álbumes de «${artist}»`);
    report(`Buscando a «${artist}» en el bot`);
    const card = await this.searchArtist(artist, index);
    const listId = await this.ensureList(card.id);
    const pages = await this.allPages(listId, "Leyendo la lista de álbumes");
    if (!pages.length || screenOf(pages[0]) !== "list") throw new BotFlowError("El bot no mostró la lista de álbumes.");
    const secciones = parseSections(pages);
    const total = Object.values(secciones).reduce((a, v) => a + v.length, 0);
    if (!total) throw new BotFlowError("La lista de álbumes llegó vacía.");
    const result: Record<string, unknown> = { artista: card.text, total, secciones, list_message_id: listId };
    if (raw) result.paginas = pages;
    return result as { artista: string; total: number; secciones: Record<string, string[]>; list_message_id: number; paginas?: Snapshot[] };
  }

  async albums(artist: string, index = 0, raw = false) {
    try {
      return await this.withRetries(() => this.albumsOnce(artist, index, raw));
    } catch (e) {
      if (e instanceof BotFlowError) return { error: e.message };
      throw e;
    }
  }

  // ------------------------------------------------- Álbumes dentro de la lista ---
  private albumButton(m: Msg, title: string, exact: boolean): Button | undefined {
    const needle = title.trim().toLowerCase();
    return exact
      ? findButton(m, (t) => t.trim().toLowerCase() === needle)
      : findButton(m, (t) => t.toLowerCase().includes(needle) && !navKind(t));
  }

  /** Recorre la lista desde la página visible, hacia delante y luego hacia atrás, hasta dar con
   *  una página donde `match` encuentre un botón. Sirve si el bot edita la lista en el mismo
   *  mensaje o si envía uno por página. */
  private async walkList(listId: number, match: (m: Msg) => Button | undefined, title: string) {
    let turned = 0;
    for (const direction of ["next", "prev"] as const) {  // nunca "back": BACK sale de la lista
      let current = listId;
      const seen = new Set<string>();
      for (let i = 0; i < this.c.maxPages; i++) {
        const msg = await this.getMsg(current);
        if (!msg || !msg.buttons.length) break;
        const btn = match(msg);
        if (btn) return { msgId: current, btn };
        const snap = snapshot(msg);
        const key = JSON.stringify([snap.text, snap.buttons]);
        if (seen.has(key)) break;
        seen.add(key);
        if (!findButton(msg, (t) => navKind(t) === direction)) break;
        const cnt = counterOf(msg);
        if (cnt && (direction === "next" ? cnt[0] >= cnt[1] : cnt[0] <= 1)) break;
        turned++;
        report(`Buscando «${title}» en otra página de la lista (${turned} revisadas)`);
        const moved = await this.turnPage(current, direction, "list", !!cnt);
        if (moved === null) break;
        current = moved;
      }
    }
    return null;
  }

  /** Pulsa el botón de navegación `kind` de un mensaje (sin coincidencia parcial). */
  async pressNav(messageId: number, kind: "next" | "prev" | "back"): Promise<Snapshot[]> {
    const msg = await this.getMsg(messageId);
    const btn = msg ? findButton(msg, (t) => navKind(t) === kind) : undefined;
    if (!btn) throw new Error(`El mensaje ${messageId} no tiene botón de navegación '${kind}'.`);
    return this.click(messageId, btn.text);
  }

  /** Pulsa el álbum `title` aunque esté en otra página. Primero coincidencia exacta en todas
   *  las páginas, después parcial. Comprueba que se abrió la ficha de ESE álbum; si el bot
   *  muestra otra cosa (otro álbum, la ficha del artista, nada), vuelve a la lista y reintenta.
   *  Devuelve [mensajes tras pulsar, id de la lista]. */
  async clickInList(listId: number, title: string): Promise<[Snapshot[], number]> {
    for (let attempt = 0; attempt <= this.c.retries; attempt++) {
      let found: { msgId: number; btn: Button } | null = null;
      for (const exact of [true, false]) {
        found = await this.walkList(listId, (m) => this.albumButton(m, title, exact), title);
        if (found) break;
      }
      if (!found) throw new BotFlowError(`No se encontró el álbum '${title}' en ninguna página de la lista.`);
      const { msgId, btn } = found;
      report(attempt ? `Abriendo «${btn.text}» otra vez (intento ${attempt + 1} de ${this.c.retries + 1})` : `Abriendo «${btn.text}»`);
      const r = await this.pressAndWait(msgId, (t) => t === btn.text, (m) => screenOf(m) === "album", `abrir «${btn.text}»`);
      if (r.ok && sameAlbum(r.msg, btn.text)) return [r.all.map(snapshot), msgId];
      report(r.ok
        ? `El bot abrió otro álbum («${albumTitleOf(r.msg)}») en lugar de «${btn.text}»; volviendo a la lista`
        : `El bot mostró otra cosa al abrir «${btn.text}»; volviendo a la lista`);
      listId = await this.ensureList(r.msg.id);
    }
    throw new BotFlowError(`El bot no abrió «${title}».`);
  }

  /** Abre un álbum y devuelve la respuesta cruda; si hay botón de canciones, recorre sus páginas. */
  async albumView(artist: string, album: string, index = 0) {
    const listing = await this.albums(artist, index);
    if (!("list_message_id" in listing)) return listing;
    const [opened] = await this.clickInList(listing.list_message_id, album);
    const result: Record<string, unknown> = { album, respuesta: opened };
    const isTracksBtn = (t: string) => TRACKS_RE.test(t) && cpLen(t) <= 20;
    const card = [...opened].reverse().find((m) => btnTexts(m).some(isTracksBtn));
    if (card) {
      const btn = btnTexts(card).find(isTracksBtn)!;
      const after = await this.click(card.message_id, btn);
      const withButtons = after.filter((m) => m.buttons?.length);
      const target = withButtons.length ? withButtons[withButtons.length - 1].message_id : card.message_id;
      result.paginas_canciones = await this.allPages(target, "Leyendo las canciones");
    }
    return result;
  }

  private async listAlive(listId: number): Promise<boolean> {
    const msg = await this.getMsg(listId);
    return !!(msg && screenOf(msg) === "list");
  }

  /** Pulsa un álbum en la lista y lee sus canciones; si la lista se reemplazó, vuelve con BACK. */
  async albumTracksFromList(listId: number, title: string): Promise<[AlbumData & { respuesta?: Snapshot[] }, number]> {
    const [opened, foundIn] = await this.clickInList(listId, title);
    listId = foundIn;
    const albumMsg = [...opened].reverse().find(hasTracks);
    if (!albumMsg) return [{ aviso: "El bot no mostró canciones para este álbum.", respuesta: opened, pistas: [] }, listId];
    const pages = await this.allPages(albumMsg.message_id, "Leyendo las canciones");
    const parsed = parseAlbum(pages);
    if (!(await this.listAlive(listId))) listId = await this.ensureList(albumMsg.message_id);
    return [parsed, listId];
  }

  // ------------------------------------------------------ Búsqueda directa del álbum ---
  /** La búsqueda inline del bot («álbum artista», sin prefijo) devuelve, además de canciones,
   *  álbumes: "Título (Album)" con el artista como descripción. Elegir uno abre su ficha al
   *  momento, sin la ficha del artista ni las páginas de la lista (~20 s cada una).
   *  Solo si hay UN resultado con el mismo título exacto y el mismo artista; si no, o si el bot
   *  abre otra cosa, devuelve null y se usa la lista de siempre. */
  private async albumDirect(artist: string, album: string): Promise<Snapshot[] | null> {
    const query = `${album} ${artist}`;
    try {
      const res = await this.t.inlineQuery(query);
      // Título exacto; si no hay, sin distinguir tildes (escrito a mano: «exitos» -> «Éxitos»).
      // Los símbolos sí cuentan: «Imparable 🅴» no es «Imparable».
      const albums = res.results.flatMap((r) => {
        const m = /^(.*) \(Album\)$/.exec(r.title ?? "");
        return m && plain(r.description ?? "") === plain(artist) ? [{ r, t: m[1].trim().toLowerCase() }] : [];
      });
      const noAccents = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "");
      const title = album.trim().toLowerCase();
      let hits = albums.filter((a) => a.t === title).map((a) => a.r);
      if (!hits.length) hits = albums.filter((a) => noAccents(a.t) === noAccents(title)).map((a) => a.r);
      if (hits.length !== 1) { this.log(`busca directo «${query}»: ${hits.length} coincidencias, se usa la lista`); return null; }
      this.log(`busca directo «${query}» -> «${hits[0].title}»`);
      report(`Abriendo «${album}» directamente`);
      const before = await this.t.lastId();
      await this.t.sendInlineResult(res.queryId, hits[0].id);
      const got = await this.awaitReply(before, null, "", (m) => screenOf(m) === "album", this.c.slowWait * 1000);
      if (got?.ok && sameAlbum(got.msg, album)) return got.all.filter((m) => m.id > before).map(snapshot);
    } catch (e) {
      this.log(`busca directo «${query}» falló: ${(e as Error)?.message || e}`);
    }
    return null;
  }

  /** Canciones de un álbum concreto de un artista. */
  async albumTracks(artist: string, album: string, index = 0) {
    // index > 0: otro artista con el mismo nombre; la búsqueda directa no sabe distinguirlos
    const direct = index ? null : await this.albumDirect(artist, album);
    const albumMsg = direct && [...direct].reverse().find(hasTracks);
    if (albumMsg) return { artista: artist, album, ...parseAlbum(await this.allPages(albumMsg.message_id, "Leyendo las canciones")) };
    return this.withRetries(async () => {
      const listing = await this.albumsOnce(artist, index);
      const [data] = await this.albumTracksFromList(listing.list_message_id, album);
      return { artista: artist, album, ...data };
    });
  }

  /** Todos los álbumes del artista, cada uno con su lista de canciones. */
  async discography(artist: string, index = 0) {
    const listing = await this.albums(artist, index);
    if (!("list_message_id" in listing)) return listing;
    let listId = listing.list_message_id;
    const secciones: Record<string, unknown[]> = {};
    for (const [section, titles] of Object.entries(listing.secciones)) {
      secciones[section] = [];
      for (const title of titles) {
        let data: Record<string, unknown>;
        try {
          const [d, id] = await this.albumTracksFromList(listId, title);
          data = d as unknown as Record<string, unknown>; listId = id;
        } catch (e) {  // un álbum que falle no debe tumbar todo el recorrido
          data = { aviso: `Error al abrir el álbum: ${(e as Error).message}` };
          try { listId = await this.ensureList(listId); } catch { /* el siguiente lo vuelve a intentar */ }
        }
        secciones[section].push({ album: title, ...data });
      }
    }
    return { artista: listing.artista, secciones };
  }

  // ------------------------------------------------------------ Para descargar ---
  /** Abre un álbum desde la lista del artista y devuelve el id de la ficha con 'GET ALL'. */
  async albumCardId(artist: string, album: string, index = 0): Promise<[number | null, Record<string, unknown> | null]> {
    const direct = index ? null : await this.albumDirect(artist, album);
    const directCard = direct && [...direct].reverse().find((m) => hasGetAll(m) && screenOf(m) === "album");
    if (directCard) return [directCard.message_id, null];
    try {
      return await this.withRetries(async () => {
        const listing = await this.albumsOnce(artist, index);
        const [opened] = await this.clickInList(listing.list_message_id, album);
        const card = [...opened].reverse().find((m) => hasGetAll(m) && screenOf(m) === "album");
        if (!card) throw new BotFlowError("El bot no mostró el botón 'GET ALL' para este álbum.");
        return [card.message_id, null] as [number, null];
      });
    } catch (e) {
      if (e instanceof BotFlowError) return [null, { album, error: e.message }];
      throw e;
    }
  }

  /** Discografía: abre `title` desde una lista ya abierta. Devuelve [ficha | null, lista, error | null]. */
  async albumCardInList(listId: number, title: string): Promise<[number | null, number, string | null]> {
    const [opened, foundIn] = await this.clickInList(listId, title);
    const card = [...opened].reverse().find((m) => hasGetAll(m) && screenOf(m) === "album");
    if (!card) return [null, foundIn, "El bot no mostró el botón 'GET ALL' para este álbum."];
    return [card.message_id, foundIn, null];
  }

  /** Tras pedir un álbum, vuelve a la lista (BACK) si el bot la reemplazó por la ficha. */
  async backToList(cardId: number, listId: number): Promise<number> {
    if (await this.listAlive(listId)) return listId;  // la lista sigue ahí
    return this.ensureList(cardId);
  }

  /** Pulsa 'GET ALL' y devuelve los mensajes con archivos, sin descargarlos. Espera hasta
   *  filesWait s al primer archivo y, si la ficha dice cuántas pistas son, sigue esperando
   *  mientras lleguen (hasta tenerlas o pasar filesGap s sin ninguna nueva). Si no llega
   *  ninguno, vuelve a pulsar GET ALL (getAllRetries veces). Los archivos repetidos se cuentan
   *  una sola vez. */
  async collectGetAll(messageId: number): Promise<Msg[]> {
    const msg = await this.getMsg(messageId);
    if (!msg || !msg.buttons.length) throw new Error(`El mensaje ${messageId} no existe o no tiene botones.`);
    const btn = findButton(msg, (t) => GET_ALL_RE.test(t));
    if (!btn) throw new Error(`El mensaje ${messageId} no tiene botón 'GET ALL'.`);
    const mt = TOTAL_TRACKS_RE.exec(msg.text || "");
    const expected = mt ? Number(mt[1]) : null;
    report("Pidiendo las pistas al bot (GET ALL)");
    const before = await this.t.lastId();
    await this.press(messageId, btn);
    let start = Date.now(), lastChange = start, docs: Msg[] = [], presses = 1;
    for (;;) {
      const fresh = await this.waitSettled(before, [messageId]);
      const found = uniqueFiles(fresh.filter((m) => m.id > before && m.hasDocument));
      const now = Date.now();
      if (found.length !== docs.length) { docs = found; lastChange = now; }
      if (docs.length && (expected === null || docs.length >= expected)) break;   // llegaron todas
      if (docs.length && now - lastChange >= this.c.filesGap * 1000) break;       // el bot dejó de enviar
      if (!docs.length && now - start >= this.c.filesWait * 1000) {               // no mandó nada a tiempo
        if (presses > this.c.getAllRetries) break;
        presses++;
        report(`El bot no envió las pistas; pidiéndolas otra vez (intento ${presses} de ${this.c.getAllRetries + 1})`);
        const again = await this.getMsg(messageId);
        const b2 = again && findButton(again, (t) => GET_ALL_RE.test(t));
        if (!b2) break;
        await this.press(messageId, b2);
        start = lastChange = Date.now();
        continue;
      }
      report(docs.length
        ? `Recibidas ${docs.length} de ${expected} pistas del bot…`
        : `Esperando a que el bot envíe las pistas (${Math.floor((now - start) / 1000)} s)…`);
      await sleep(this.c.pollMs);
    }
    return docs;
  }
}

/** Quita archivos repetidos (si el bot los mandó dos veces), conservando el primero. */
function uniqueFiles(msgs: Msg[]): Msg[] {
  const seen = new Set<string>();
  return msgs.sort((a, b) => a.id - b.id).filter((m) => {
    const d = m.media as DocInfo | undefined;
    const key = d?.kind === "document" && (d.file_name || d.title) ? `${d.file_name}|${d.title}|${d.size}` : `id:${m.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
