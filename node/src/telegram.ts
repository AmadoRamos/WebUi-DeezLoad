/**
 * Conexión con Telegram usando GramJS (paquete `telegram`), con tu cuenta.
 * Traduce los mensajes de GramJS al formato común (`Msg`) y ofrece lo que la lógica necesita.
 *
 * La sesión es PROPIA de Node (archivo deezload_node.session). No reutiliza la de Telethon:
 * si dos programas usan la misma clave a la vez, Telegram puede invalidarla.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Api, TelegramClient, helpers, sessions } from "telegram";
import type { Config } from "./config.js";
import type { Button, DocInfo, InlineResult, MediaInfo, Msg, Transport } from "./types.js";

function toButton(b: Api.TypeKeyboardButton): Button {
  const text = (b as { text?: string }).text ?? "";
  if (b instanceof Api.KeyboardButtonCallback) return { text, kind: "callback", data: Buffer.from(b.data) };
  if (b instanceof Api.KeyboardButtonSwitchInline) return { text, kind: "switch_inline", query: b.query };
  if (b instanceof Api.KeyboardButtonUrl) return { text, kind: "url", url: b.url };
  return { text, kind: "other" };
}

function describeMedia(m: Api.Message): MediaInfo | undefined {
  const media = m.media;
  if (!media) return undefined;
  if (media instanceof Api.MessageMediaPhoto) return { kind: "photo" };
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const doc = media.document;
    const info: DocInfo = { kind: "document", mime: doc.mimeType, size: Number(doc.size) };
    for (const a of doc.attributes) {
      if (a instanceof Api.DocumentAttributeFilename) info.file_name = a.fileName;
      else if (a instanceof Api.DocumentAttributeAudio) {
        info.audio = true; info.title = a.title; info.performer = a.performer; info.duration = a.duration;
      } else if (a instanceof Api.DocumentAttributeVideo) { info.video = true; info.duration = a.duration; }
    }
    return info;
  }
  return { kind: media.className };
}

export function toMsg(m: Api.Message): Msg {
  const markup = m.replyMarkup;
  const rows = markup instanceof Api.ReplyInlineMarkup || markup instanceof Api.ReplyKeyboardMarkup ? markup.rows : [];
  const media = describeMedia(m);
  return {
    id: m.id,
    text: m.message || "",
    buttons: rows.map((r) => r.buttons.map(toButton)),
    out: !!m.out,
    viaBot: m.viaBotId != null,
    editDate: m.editDate || 0,
    media,
    hasDocument: media?.kind === "document",
    raw: m,
  };
}

const isMessage = (m: unknown): m is Api.Message => m instanceof Api.Message;

export class GramTransport implements Transport {
  private botPeer: Api.TypeInputPeer | null = null;
  constructor(readonly client: TelegramClient, private c: Config) {}

  private async peer(): Promise<Api.TypeInputPeer> {
    if (!this.botPeer) this.botPeer = await this.client.getInputEntity(this.c.bot);
    return this.botPeer;
  }

  async getMessages(ids: number[]): Promise<(Msg | undefined)[]> {
    const res = await this.client.getMessages(await this.peer(), { ids });
    return ids.map((_, i) => (isMessage(res[i]) ? toMsg(res[i]) : undefined));
  }

  async getSince(minId: number, limit: number): Promise<Msg[]> {
    const res = await this.client.getMessages(await this.peer(), { minId, limit });
    return res.filter(isMessage).map(toMsg);
  }

  async lastId(): Promise<number> {
    const res = await this.client.getMessages(await this.peer(), { limit: 1 });
    return res.length && isMessage(res[0]) ? res[0].id : 0;
  }

  async pressButton(msgId: number, b: Button): Promise<void> {
    if (b.kind !== "callback" || !b.data) throw new Error(`El botón '${b.text}' no es de tipo callback.`);
    await this.client.invoke(new Api.messages.GetBotCallbackAnswer({ peer: await this.peer(), msgId, data: b.data }));
  }

  async inlineQuery(query: string, offset?: string) {
    const peer = await this.peer();
    const res = await this.client.invoke(new Api.messages.GetInlineBotResults({ bot: this.c.bot, peer, query, offset: offset || "" }));
    const results: InlineResult[] = res.results.map((r) => ({
      id: r.id, title: (r as Api.BotInlineResult).title, description: (r as Api.BotInlineResult).description,
      type: r.type, url: (r as Api.BotInlineResult).url,
    }));
    return { queryId: res.queryId, results, nextOffset: res.nextOffset || undefined };
  }

  async sendInlineResult(queryId: unknown, resultId: string): Promise<void> {
    await this.client.invoke(new Api.messages.SendInlineBotResult({
      peer: await this.peer(), queryId: queryId as Api.long, id: resultId, randomId: helpers.generateRandomBigInt(),
    }));
  }

  async sendMessage(text: string): Promise<Msg> {
    return toMsg(await this.client.sendMessage(await this.peer(), { message: text }));
  }

  /** Baja el archivo del mensaje. Si Telegram responde que el permiso del archivo caducó
   *  (FILE_REFERENCE_EXPIRED: pasa cuando el mensaje se leyó hace rato, p. ej. con muchas
   *  descargas en cola o una discografía larga), vuelve a pedir ese mensaje al chat y repite la
   *  descarga una vez, desde el principio. */
  async download(msg: Msg, path: string, onProgress?: (received: number, total: number) => void): Promise<void> {
    if (!(msg.raw instanceof Api.Message) || !msg.raw.media) throw new Error("Ese mensaje no tiene archivo.");
    try {
      await this.downloadOnce(msg.raw, path, onProgress);
    } catch (e) {
      if (!isFileReferenceError(e)) throw e;
      const [fresh] = await this.getMessages([msg.id]);
      if (!(fresh?.raw instanceof Api.Message) || !fresh.raw.media)
        throw new Error("El archivo ya no está en el chat con el bot. Vuelve a pedir el álbum.");
      msg.raw = fresh.raw;   // quien lo vuelva a usar, que use el permiso nuevo
      onProgress?.(0, 0);    // empieza de cero
      await this.downloadOnce(fresh.raw, path, onProgress);
    }
  }

  /** GramJS escribe en el `outputFile` que le demos y espera cada `write`. Usamos un escritor
   *  propio para esperar también a que el archivo quede cerrado antes de renombrarlo
   *  (con una ruta, GramJS cierra su WriteStream sin esperar a que termine de vaciarse).
   *  El archivo se abre en modo "w": un segundo intento lo empieza vacío. */
  private async downloadOnce(raw: Api.Message, path: string, onProgress?: (received: number, total: number) => void) {
    const fh = await open(path, "w");
    let closing: Promise<void> | null = null;
    const close = () => (closing ??= fh.close());
    const writer = { write: async (chunk: Buffer) => { await fh.write(chunk); }, close: () => { void close(); } };
    try {
      await this.client.downloadMedia(raw, {
        outputFile: writer as never,
        progressCallback: (d, t) => onProgress?.(Number(d), Number(t)),
      });
    } finally {
      await close();
    }
  }
}

/** Telegram avisa que el permiso para bajar el archivo caducó o ya no vale. */
export function isFileReferenceError(e: unknown): boolean {
  const text = String((e as { errorMessage?: string })?.errorMessage ?? "") + " " + String((e as Error)?.message ?? "");
  return /FILE_REFERENCE_(EXPIRED|INVALID)/.test(text);
}

// ---------------------------------------------------------------- Conexión ---
let shared: Promise<{ client: TelegramClient; transport: GramTransport }> | null = null;

function loadSession(c: Config): string {
  return existsSync(c.sessionFile) ? readFileSync(c.sessionFile, "utf8").trim() : "";
}

async function open1(c: Config) {
  if (!c.apiId || !c.apiHash) throw new Error("Faltan TG_API_ID y TG_API_HASH en el archivo .env.");
  const client = new TelegramClient(new sessions.StringSession(loadSession(c)), c.apiId, c.apiHash, { connectionRetries: 5 });
  client.setLogLevel("error" as never);
  await client.connect();
  if (!(await client.checkAuthorization())) {
    await client.disconnect();
    throw new Error("Sesión de Telegram para Node no iniciada. Ejecuta primero: npm run cli -- login");
  }
  return { client, transport: new GramTransport(client, c) };
}

/** Conecta con la sesión guardada (una sola conexión aunque lo pidan varios a la vez).
 *  Si no hay sesión válida, pide ejecutar `login`; el siguiente intento vuelve a probar. */
export function connect(c: Config) {
  if (!shared) shared = open1(c).catch((e) => { shared = null; throw e; });
  return shared;
}

/** Un Transport que conecta con Telegram la primera vez que se usa (el servidor arranca
 *  aunque Telegram no esté disponible; el error sale en la operación que lo necesitó). */
export class LazyTransport implements Transport {
  constructor(private c: Config) {}
  private t() { return connect(this.c).then((s) => s.transport); }
  async getMessages(ids: number[]) { return (await this.t()).getMessages(ids); }
  async getSince(minId: number, limit: number) { return (await this.t()).getSince(minId, limit); }
  async lastId() { return (await this.t()).lastId(); }
  async pressButton(msgId: number, b: Button) { return (await this.t()).pressButton(msgId, b); }
  async inlineQuery(q: string, offset?: string) { return (await this.t()).inlineQuery(q, offset); }
  async sendInlineResult(queryId: unknown, resultId: string) { return (await this.t()).sendInlineResult(queryId, resultId); }
  async sendMessage(text: string) { return (await this.t()).sendMessage(text); }
  async download(msg: Msg, path: string, onProgress?: (r: number, t: number) => void) { return (await this.t()).download(msg, path, onProgress); }
}

/** Inicio de sesión interactivo (teléfono + código + contraseña si la tienes). Guarda la sesión. */
export async function login(c: Config) {
  if (!c.apiId || !c.apiHash) throw new Error("Faltan TG_API_ID y TG_API_HASH en el archivo .env.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => rl.question(q);
  const client = new TelegramClient(new sessions.StringSession(loadSession(c)), c.apiId, c.apiHash, { connectionRetries: 5 });
  client.setLogLevel("error" as never);
  try {
    await client.start({
      phoneNumber: () => ask("Número de teléfono (con +código de país): "),
      password: () => ask("Contraseña de verificación en dos pasos: "),
      phoneCode: () => ask("Código que te llegó a Telegram: "),
      onError: (e) => { console.error("Error:", e.message); },
    });
    writeFileSync(c.sessionFile, String(client.session.save()), { encoding: "utf8", mode: 0o600 });
    const me = await client.getMe();
    return { nombre: (me as Api.User).firstName, usuario: (me as Api.User).username, sesion: c.sessionFile };
  } finally {
    rl.close();
    await client.disconnect();
  }
}

export async function disconnect() {
  const s = shared;
  shared = null;
  if (s) await s.then((x) => x.client.disconnect(), () => {});
}
