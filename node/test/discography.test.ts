/** Port de test_disco.py: discografía en orden estricto, con pausa, cancelar y reintentos. */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, it } from "node:test";
import { Discography, type DiscBot } from "../src/discography.js";
import { Downloader, Mutex, type DownloadJob, type GetAudios } from "../src/downloads.js";
import type { Msg, Transport } from "../src/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let events: [string, string][], calls: number, emptyOnce: Set<string>, loseList: Set<string>, direct: Set<string>;
let dl: Downloader, dir: string, turn: Mutex;

const files = {
  async download(_m: Msg, path: string) { await sleep(30); writeFileSync(path, "x".repeat(100)); },
} as unknown as Transport;

const bot: DiscBot = {
  albums: (async () => { calls++; await sleep(10); return { list_message_id: 1 }; }) as never,
  albumCardDirect: async (artist: string, title: string) => {
    if (!direct.has(title)) return null;
    events.push(["abre", title]); events.push(["directo", `${artist}|${title}`]);
    return 200;
  },
  albumCardInList: async (listId: number, title: string) => {
    if (loseList.has(title)) { loseList.delete(title); throw new Error("No hay botón que coincida"); }
    events.push(["abre", title]);
    return [100, listId, null];
  },
  collectGetAll: async () => {
    const title = events.filter((e) => e[0] === "abre").at(-1)![1];
    if (emptyOnce.has(title)) { emptyOnce.delete(title); return []; }
    return [0, 1].map((i) => ({ id: i, text: "", buttons: [], out: false, viaBot: false, editDate: 0, hasDocument: true,
      media: { kind: "document", file_name: `Artista - ${title} ${i}.flac`, title: `${title} ${i}`, size: 100 } }));
  },
  backToList: async (_c: number, listId: number) => listId,
};

beforeEach(() => {
  events = []; calls = 0; emptyOnce = new Set(); loseList = new Set(); direct = new Set(); turn = new Mutex();
  dir = join(mkdtempSync(join(tmpdir(), "disc-")), "dl");
  dl = new Downloader(files, bot as never, dir, join(dir, "..", "ajustes.json"));
  const run = dl.runJob.bind(dl);
  dl.runJob = async (job: DownloadJob, g?: GetAudios) => { events.push(["inicio", job.album]); await run(job, g); events.push(["fin", job.album]); };
});

const start = (titles: string[]) => {
  const d = new Discography("Artista", "Artista", 0, titles.map((title) => ({ title, section: "Albums" })),
                            { bot, downloader: dl, turn, pauseSeconds: 0.05, notify: () => {} });
  return { d, done: d.run() };
};

it("orden estricto: cada álbum termina antes del siguiente; la lista se abre una vez", async () => {
  const { d, done } = start(["A1", "A2", "A3", "A4"]);
  await done;
  assert.deepEqual(events.filter((e) => e[0] !== "abre"), ["A1", "A2", "A3", "A4"].flatMap((a) => [["inicio", a], ["fin", a]]));
  assert.equal(calls, 1);
  assert.equal(d.status, "completed");
  assert.deepEqual(d.albums.map((a) => a.status), Array(4).fill("completed"));
});

it("sin pistas: sigue con el resto y lo reintenta al final con el mismo trabajo", async () => {
  emptyOnce.add("B2");
  const { d, done } = start(["B1", "B2", "B3"]);
  await done;
  assert.deepEqual(events.filter((e) => e[0] === "inicio").map((e) => e[1]), ["B1", "B2", "B3", "B2"]);
  assert.equal(d.albums[1].status, "completed");
  assert.equal(dl.jobs.get(d.albums[1].job_id!)!.attempts, 2);
});

it("pausa: se detiene tras el álbum en curso; reanudar termina todo", async () => {
  const { d, done } = start(["C1", "C2", "C3"]);
  while (!events.some((e) => e[0] === "fin" && e[1] === "C1")) await sleep(5);
  d.pause();
  await sleep(400);
  assert.equal(d.status, "paused");
  assert.equal(d.albums[2].status, "pending");
  d.continue();
  await done;
  assert.equal(d.status, "completed");
  assert.ok(d.albums.every((a) => a.status === "completed"));
});

it("cancelar: el álbum en curso termina, el resto se cancela", async () => {
  const { d, done } = start(["D1", "D2", "D3", "D4"]);
  while (!events.some((e) => e[0] === "inicio" && e[1] === "D2")) await sleep(5);
  d.cancel();
  await done;
  assert.deepEqual(d.albums.map((a) => a.status), ["completed", "completed", "canceled", "canceled"]);
  assert.equal(d.status, "canceled");
});

it("pausar antes de empezar y cancelar: no descarga nada", async () => {
  const { d, done } = start(["P1", "P2"]);
  d.pause();
  assert.equal(d.status, "paused");      // aún no había empezado (como en Python)
  await sleep(50);
  assert.equal(events.length, 0);
  d.cancel();
  await done;
  assert.deepEqual(d.albums.map((a) => a.status), ["canceled", "canceled"]);
  assert.equal(d.status, "canceled");
});

it("pausar durante un álbum: lo termina y se detiene; cancelar en pausa", async () => {
  const { d, done } = start(["Q1", "Q2"]);
  while (!events.some((e) => e[0] === "inicio")) await sleep(5);
  d.pause();
  assert.equal(d.toDict().pausando, true);
  while (d.status !== "paused") await sleep(5);
  d.cancel();
  await done;
  assert.deepEqual(d.albums.map((a) => a.status), ["completed", "canceled"]);
});

it("lista perdida: se vuelve a abrir y el álbum se reintenta", async () => {
  loseList.add("E2");
  const { d, done } = start(["E1", "E2", "E3"]);
  await done;
  assert.equal(calls, 2);
  assert.ok(d.albums.every((a) => a.status === "completed"));
});

it("álbum que ya tenías completo: 'ya estaban'", async () => {
  for (const i of [0, 1]) writeFileSync(join(dir, `Artista - F1 ${i}.flac`), "x");
  const { d, done } = start(["F1", "F2"]);
  await done;
  assert.deepEqual(d.albums.map((a) => a.status), ["exists", "completed"]);
  assert.equal(d.toDict().ya_estaban, 1);
});

it("una discografía a la vez: la segunda espera su turno", async () => {
  const a = start(["G1", "G2"]), b = start(["H1"]);
  assert.equal(b.d.status, "queued");
  await Promise.all([a.done, b.done]);
  assert.deepEqual(events.filter((e) => e[0] === "inicio").map((e) => e[1]), ["G1", "G2", "H1"]);
});

it("queuedKeys: lo pendiente, sin tildes ni etiquetas; nada al terminar", async () => {
  const { d, done } = start(["Ñandú (Album Version)"]);
  assert.ok(d.queuedKeys().has("artista|nandu"));
  await done;
  assert.equal(d.queuedKeys().size, 0);
});

it("búsqueda directa primero, con el nombre del bot; la lista solo para los que no se encuentran", async () => {
  ["D1", "D3"].forEach((t) => direct.add(t));
  const d = new Discography("artista mal escrito", "Artista", 0, ["D1", "D2", "D3"].map((title) => ({ title, section: "Albums" })),
                            { bot, downloader: dl, turn, pauseSeconds: 0, notify: () => {} });
  await d.run();
  assert.deepEqual(events.filter((e) => e[0] === "directo").map((e) => e[1]), ["Artista|D1", "Artista|D3"]);
  assert.equal(calls, 1);   // la lista se abrió solo para D2
  assert.ok(d.albums.every((a) => a.status === "completed"));
});
