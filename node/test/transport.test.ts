/** GramTransport: que arme bien las peticiones a Telegram (con un cliente falso que las registra). */
import assert from "node:assert/strict";
import { it } from "node:test";
import { Api, TelegramClient } from "telegram";
import bigInt from "big-integer";
import { cfg } from "../src/config.js";
import { GramTransport } from "../src/telegram.js";

const peer = new Api.InputPeerUser({ userId: bigInt(777), accessHash: bigInt(1) });
const mk = (id: number, extra: Partial<ConstructorParameters<typeof Api.Message>[0]> = {}) =>
  new Api.Message({ id, peerId: new Api.PeerUser({ userId: bigInt(777) }), date: 0, message: `m${id}`, ...extra });

function fakeClient() {
  const calls: { method: string; args: unknown[] }[] = [];
  const client = {
    getInputEntity: async (x: unknown) => { calls.push({ method: "getInputEntity", args: [x] }); return peer; },
    getMessages: async (_p: unknown, params: { ids?: number[]; minId?: number; limit?: number }) => {
      calls.push({ method: "getMessages", args: [params] });
      if (params.ids) return params.ids.map((i) => (i === 404 ? undefined : mk(i)));
      return [mk(12, { out: true }), mk(11, { viaBotId: bigInt(5) })];
    },
    invoke: async (req: unknown) => {
      calls.push({ method: "invoke", args: [req] });
      if (req instanceof Api.messages.GetInlineBotResults)
        return new Api.messages.BotResults({ queryId: bigInt(99), results: [new Api.BotInlineResult({ id: "r1", type: "article", title: "Soda Stereo", sendMessage: new Api.BotInlineMessageText({ message: "x" }) })], nextOffset: "10", cacheTime: 0, users: [] });
      return true;
    },
    sendMessage: async (_p: unknown, o: { message: string }) => { calls.push({ method: "sendMessage", args: [o] }); return mk(50); },
  };
  return { client: client as unknown as TelegramClient, calls };
}

it("getMessages por id (los que no existen quedan undefined) y getSince", async () => {
  const { client, calls } = fakeClient();
  const t = new GramTransport(client, cfg);
  const got = await t.getMessages([3, 404]);
  assert.equal(got[0]!.id, 3); assert.equal(got[1], undefined);
  const since = await t.getSince(10, 50);
  assert.deepEqual(since.map((m) => [m.id, m.out, m.viaBot]), [[12, true, false], [11, false, true]]);
  assert.deepEqual(calls.filter((c) => c.method === "getMessages").map((c) => c.args[0]), [{ ids: [3, 404] }, { minId: 10, limit: 50 }]);
  assert.equal(calls.filter((c) => c.method === "getInputEntity").length, 1, "el bot se resuelve una sola vez");
});

it("pulsar un botón envía GetBotCallbackAnswer con el mensaje y los datos del botón", async () => {
  const { client, calls } = fakeClient();
  await new GramTransport(client, cfg).pressButton(42, { text: "ALBUMS", kind: "callback", data: Buffer.from("alb") });
  const req = calls.find((c) => c.method === "invoke")!.args[0] as Api.messages.GetBotCallbackAnswer;
  assert.ok(req instanceof Api.messages.GetBotCallbackAnswer);
  assert.equal(req.msgId, 42); assert.equal(Buffer.from(req.data!).toString(), "alb"); assert.equal(req.peer, peer);
  await assert.rejects(new GramTransport(client, cfg).pressButton(1, { text: "Web", kind: "url", url: "x" }), /no es de tipo callback/);
});

it("consulta inline y elegir resultado (con randomId)", async () => {
  const { client, calls } = fakeClient();
  const t = new GramTransport(client, cfg);
  const r = await t.inlineQuery(".art Soda Stereo");
  assert.deepEqual(r.results, [{ id: "r1", title: "Soda Stereo", description: undefined, type: "article", url: undefined }]);
  assert.equal(r.nextOffset, "10");
  const q = calls.find((c) => c.args[0] instanceof Api.messages.GetInlineBotResults)!.args[0] as Api.messages.GetInlineBotResults;
  assert.equal(q.query, ".art Soda Stereo"); assert.equal(q.offset, ""); assert.equal(q.bot, cfg.bot);
  await t.sendInlineResult(r.queryId, "r1");
  const s = calls.find((c) => c.args[0] instanceof Api.messages.SendInlineBotResult)!.args[0] as Api.messages.SendInlineBotResult;
  assert.equal(s.id, "r1"); assert.ok(bigInt(99).equals(s.queryId as bigInt.BigInteger)); assert.ok(s.randomId, "randomId");
});

// ---- download: imita a GramJS (espera cada write, llama a close() sin esperarlo)
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toMsg } from "../src/telegram.js";

function downloadClient(chunks: number, failAt = -1) {
  return {
    downloadMedia: async (_m: unknown, o: { outputFile: { write(b: Buffer): Promise<void>; close(): void }; progressCallback: (d: unknown, t: unknown) => void }) => {
      try {
        for (let i = 0; i < chunks; i++) {
          if (i === failAt) throw new Error("conexión cortada");
          await o.outputFile.write(Buffer.alloc(4096, 65 + i));
          o.progressCallback(bigInt(4096 * (i + 1)), bigInt(4096 * chunks));
        }
      } finally { o.outputFile.close(); }
      return undefined;
    },
  } as unknown as TelegramClient;
}
const audio = () => toMsg(mk(70, { media: new Api.MessageMediaDocument({ document: new Api.Document({
  id: bigInt(1), accessHash: bigInt(2), fileReference: Buffer.alloc(0), date: 0, mimeType: "audio/flac", size: bigInt(4096 * 3), dcId: 1,
  attributes: [new Api.DocumentAttributeFilename({ fileName: "A - B.flac" })] }) }) }));

it("download: el archivo queda completo y cerrado al terminar; avisa el avance", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "tg-")), "x.part");
  const seen: [number, number][] = [];
  await new GramTransport(downloadClient(3), cfg).download(audio(), path, (r, t) => seen.push([r, t]));
  const data = readFileSync(path);
  assert.equal(data.length, 4096 * 3);
  assert.equal(data[0], 65); assert.equal(data[4096 * 2], 67);
  assert.deepEqual(seen, [[4096, 12288], [8192, 12288], [12288, 12288]]);
});

it("download: si se corta, falla (y el archivo se cierra igual)", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "tg-")), "x.part");
  await assert.rejects(new GramTransport(downloadClient(3, 1), cfg).download(audio(), path), /conexión cortada/);
  assert.equal(readFileSync(path).length, 4096);
});

it("download: un mensaje sin archivo da un error claro", async () => {
  await assert.rejects(new GramTransport(downloadClient(1), cfg).download(toMsg(mk(71)), "/tmp/nada"), /no tiene archivo/);
});

// ---- download: permiso del archivo caducado (FILE_REFERENCE_EXPIRED)
import { errors } from "telegram";
import { isFileReferenceError } from "../src/telegram.js";

/** Cliente falso: los mensajes "viejos" (fileReference 'old') dan FILE_REFERENCE_EXPIRED a mitad
 *  de la descarga; getMessages devuelve el mensaje con un permiso nuevo (o nada si se borró). */
function expiringClient(opts: { refreshed?: "new" | "old" | "gone"; error?: Error } = {}) {
  const log: string[] = [];
  const doc = (ref: string) => mk(70, { media: new Api.MessageMediaDocument({ document: new Api.Document({
    id: bigInt(1), accessHash: bigInt(2), fileReference: Buffer.from(ref), date: 0, mimeType: "audio/flac", size: bigInt(8192), dcId: 1,
    attributes: [new Api.DocumentAttributeFilename({ fileName: "A - B.flac" })] }) }) });
  const client = {
    getInputEntity: async () => peer,
    getMessages: async (_p: unknown, params: { ids: number[] }) => {
      log.push(`getMessages ${params.ids}`);
      return opts.refreshed === "gone" ? [undefined] : [doc(opts.refreshed ?? "new")];
    },
    downloadMedia: async (m: Api.Message, o: { outputFile: { write(b: Buffer): Promise<void>; close(): void }; progressCallback: (d: unknown, t: unknown) => void }) => {
      const ref = Buffer.from(((m.media as Api.MessageMediaDocument).document as Api.Document).fileReference).toString();
      log.push(`descarga con ${ref}`);
      try {
        await o.outputFile.write(Buffer.alloc(4096, 1));
        o.progressCallback(bigInt(4096), bigInt(8192));
        if (opts.error) throw opts.error;
        if (ref === "old") throw new errors.RPCError("FILE_REFERENCE_EXPIRED", new Api.upload.GetFile({ location: new Api.InputDocumentFileLocation({ id: bigInt(1), accessHash: bigInt(2), fileReference: Buffer.from(ref), thumbSize: "" }), offset: bigInt(0), limit: 4096 }), 400);
        await o.outputFile.write(Buffer.alloc(4096, 2));
        o.progressCallback(bigInt(8192), bigInt(8192));
      } finally { o.outputFile.close(); }
    },
  } as unknown as TelegramClient;
  return { client, log, msg: toMsg(doc("old")) };
}
const tmpPart = () => join(mkdtempSync(join(tmpdir(), "tg-")), "x.part");

it("permiso caducado: vuelve a pedir el mensaje y baja completo con el permiso nuevo", async () => {
  const { client, log, msg } = expiringClient();
  const path = tmpPart(), seen: number[] = [];
  await new GramTransport(client, cfg).download(msg, path, (r) => seen.push(r));
  assert.deepEqual(log, ["descarga con old", "getMessages 70", "descarga con new"]);
  const data = readFileSync(path);
  assert.equal(data.length, 8192);                 // no quedan restos del primer intento
  assert.equal(data[0], 1); assert.equal(data[4096], 2);
  assert.deepEqual(seen, [4096, 0, 4096, 8192]);   // el avance vuelve a 0 al reintentar
  assert.equal(Buffer.from(((msg.raw as Api.Message).media as Api.MessageMediaDocument & { document: Api.Document }).document.fileReference).toString(), "new");
});

it("permiso caducado dos veces: se rinde con el error de Telegram", async () => {
  const { client, log, msg } = expiringClient({ refreshed: "old" });
  await assert.rejects(new GramTransport(client, cfg).download(msg, tmpPart()), /FILE_REFERENCE_EXPIRED/);
  assert.equal(log.filter((l) => l.startsWith("descarga")).length, 2);
});

it("permiso caducado y el mensaje ya no está: error claro", async () => {
  const { client, msg } = expiringClient({ refreshed: "gone" });
  await assert.rejects(new GramTransport(client, cfg).download(msg, tmpPart()), /ya no está en el chat/);
});

it("otros errores no se reintentan", async () => {
  const { client, log, msg } = expiringClient({ error: new Error("conexión cortada") });
  await assert.rejects(new GramTransport(client, cfg).download(msg, tmpPart()), /conexión cortada/);
  assert.deepEqual(log, ["descarga con old"]);
});

it("reconoce el error por su código o por su texto", () => {
  assert.ok(isFileReferenceError(new errors.RPCError("FILE_REFERENCE_EXPIRED", new Api.help.GetConfig(), 400)));
  assert.ok(isFileReferenceError(new Error("400: FILE_REFERENCE_INVALID (caused by upload.GetFile)")));
  assert.ok(!isFileReferenceError(new Error("FLOOD_WAIT_30")));
  assert.ok(!isFileReferenceError(undefined));
});
