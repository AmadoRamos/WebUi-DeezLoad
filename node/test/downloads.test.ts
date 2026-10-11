/** Port de test_paralelo.py: descargas en secuencia / simultáneas con un Telegram falso. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import type { Bot } from "../src/bot.js";
import { DownloadJob, Downloader, FileSlots, loadSettings, Mutex } from "../src/downloads.js";
import type { Msg, Transport } from "../src/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Telegram falso: solo `download` hace algo (escribe 1000 bytes en 4 trozos). */
class FakeFiles implements Partial<Transport> {
  log: [string, number][] = [];
  active = 0; maxSeen = 0;
  fail = new Set<string>();
  writing = new Set<string>();
  async download(msg: Msg, path: string, onProgress?: (r: number, t: number) => void) {
    const key = path.toLowerCase();
    assert.ok(!this.writing.has(key), `¡mismo archivo escrito a la vez! ${path}`);
    this.writing.add(key); this.active++; this.maxSeen = Math.max(this.maxSeen, this.active);
    const [album, i] = msg.raw as [string, number];
    this.log.push([album, i]);
    try {
      writeFileSync(path, "");
      for (let k = 0; k < 4; k++) {
        await sleep(20);
        onProgress?.(250 * (k + 1), 1000);
      }
      if (this.fail.has(`${album}:${i}`)) throw new Error("conexión cortada");
      writeFileSync(path, "x".repeat(1000));
    } finally { this.active--; this.writing.delete(key); }
  }
}

const doc = (album: string, i: number, fileName: string): Msg => ({
  id: i, text: "", buttons: [], out: false, viaBot: false, editDate: 0, hasDocument: true, raw: [album, i],
  media: { kind: "document", file_name: fileName, title: `${album} ${i}`, size: 1000 },
});
const album = (name: string, n: number, nameOf = (i: number) => `${name}-${i}.flac`) =>
  async () => Array.from({ length: n }, (_, i) => doc(name, i, nameOf(i)));

let files: FakeFiles, dl: Downloader, dir: string, settings: string, emptyOnce: Set<string>;
const fakeBot = {
  albumCardId: async (_artist: string, alb: string) => [alb, null],
  collectGetAll: async (card: string) => {
    if (emptyOnce.has(card)) { emptyOnce.delete(card); return []; }
    return (await album(card, 3)());
  },
} as unknown as Bot;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "dl-"));
  dir = join(base, "downloads"); settings = join(base, "ajustes.json");
  files = new FakeFiles(); emptyOnce = new Set();
  dl = new Downloader(files as unknown as Transport, fakeBot, dir, settings);
});

async function runAll(limit: number, specs: [string, () => Promise<Msg[]>][], during?: () => Promise<void>) {
  dl.slots.setLimit(limit);
  const jobs = specs.map(([name]) => new DownloadJob("Artista", name));
  const runs = jobs.map((j, k) => dl.runJob(j, specs[k][1]));
  if (during) await during();
  await Promise.all(runs);
  return jobs;
}

describe("cupos", () => {
  it("1 a la vez: nunca más de 1, álbum por álbum y pista por pista", async () => {
    const jobs = await runAll(1, [["A", album("A", 3)], ["B", album("B", 3)]]);
    assert.equal(files.maxSeen, 1);
    assert.deepEqual(files.log, [["A", 0], ["A", 1], ["A", 2], ["B", 0], ["B", 1], ["B", 2]]);
    assert.ok(jobs.every((j) => j.status === "completed"));
  });

  it("5 a la vez: llega a 5 y el primer álbum empieza primero", async () => {
    const jobs = await runAll(5, [["C", album("C", 3)], ["D", album("D", 4)]]);
    assert.equal(files.maxSeen, 5);
    assert.deepEqual(files.log.slice(0, 3), [["C", 0], ["C", 1], ["C", 2]]);
    assert.ok(jobs.every((j) => j.status === "completed"));
  });

  it("en caliente: al subir arrancan más; al bajar, quedan en 1", async () => {
    const seen: Record<string, number> = {};
    const [job] = await runAll(1, [["E", album("E", 8)]], async () => {
      await sleep(50); seen.antes = files.active;
      dl.slots.setLimit(3); await sleep(30); seen.subir = files.active;
      dl.slots.setLimit(1); await sleep(120); seen.bajar = files.active;
    });
    assert.ok(seen.antes <= 1);
    assert.equal(seen.subir, 3);
    assert.ok(seen.bajar <= 1);
    assert.equal(job.status, "completed");
    assert.equal(job.toDict().done, 8);
  });

  it("FileSlots respeta la prioridad [álbum, pista]", async () => {
    const s = new FileSlots(0); const order: string[] = [];
    const take = (p: number[]) => s.acquire(p).then(() => { order.push(p.join(".")); });
    const all = [take([2, 0]), take([1, 1]), take([1, 0])];
    s.setLimit(3); await Promise.all(all);
    assert.deepEqual(order, ["1.0", "1.1", "2.0"]);
  });

  it("Mutex: de uno en uno y en orden de llegada", async () => {
    const m = new Mutex(); const log: number[] = []; let inside = 0;
    await Promise.all([30, 5, 10].map((ms, i) => m.run(async () => { inside++; assert.equal(inside, 1); await sleep(ms); log.push(i); inside--; })));
    assert.deepEqual(log, [0, 1, 2]);
  });
});

describe("pistas", () => {
  it("una pista falla: las demás terminan y el álbum avisa", async () => {
    files.fail.add("F:1");
    const [j] = await runAll(3, [["F", album("F", 4)]]);
    assert.equal(j.toDict().done, 3);
    assert.equal(j.tracks[1].status, "error");
    assert.equal(j.status, "error");
    assert.match(j.error!, /1 de 4/);
    assert.match(j.error!, /conexión cortada/);
  });

  it("mismo nombre de archivo: nunca a la vez; se baja una vez y el resto 'ya estaba'", async () => {
    const [j] = await runAll(5, [["G", album("G", 4, () => "mismo nombre.flac")]]);
    const st = j.tracks.map((t) => t.status);
    assert.equal(st.filter((s) => s === "done").length, 1);
    assert.equal(st.filter((s) => s === "exists").length, 3);
  });

  it("ya estaba (mismo nombre, otro tamaño): no se descarga y cuenta como hecho", async () => {
    writeFileSync(join(dir, "H-0.flac"), "x".repeat(1000));
    writeFileSync(join(dir, "H-1.flac"), "x".repeat(400));
    const [h] = await runAll(2, [["H", album("H", 3)]]);
    assert.deepEqual(files.log, [["H", 2]]);
    const d = h.toDict();
    assert.equal(d.done, 3); assert.equal(d.existing, 2); assert.equal(h.status, "completed");
    assert.equal(h.tracks[0].file, "H-0.flac"); assert.equal(h.tracks[0].progress, 1000);
    assert.equal(h.tracks[1].size, 400);
  });

  it("otro nombre, misma canción: enlaza al archivo que ya tenías, sin duplicar", async () => {
    writeFileSync(join(dir, "Eddy Herrera - Callejón Sin Salida.flac"), "x".repeat(777));
    writeFileSync(join(dir, "Eddy Herrera - Seguire Buscandola.flac"), "x".repeat(888));
    const names = ["Eddy Herrera - Callejon Sin Salida.flac", "Eddy Herrera - Seguire Buscandola (Album Version).flac", "Eddy Herrera - Su Mirada.flac"];
    const [e] = await runAll(3, [["EH", album("EH", 3, (i) => names[i])]]);
    assert.deepEqual(files.log, [["EH", 2]]);
    assert.equal(e.tracks[0].file, "Eddy Herrera - Callejón Sin Salida.flac");
    assert.equal(e.tracks[1].size, 888);
    assert.ok(!existsSync(join(dir, "Eddy Herrera - Callejon Sin Salida.flac")));
  });

  it("descarga cortada: sin archivo final ni .part; al reintentar se baja completa", async () => {
    files.fail.add("P:0");
    const j = new DownloadJob("Artista", "P");
    await dl.runJob(j, album("P", 1));
    assert.ok(!existsSync(join(dir, "P-0.flac")) && !existsSync(join(dir, "P-0.flac.part")));
    files.fail.clear(); j.resetForRetry();
    await dl.runJob(j, album("P", 1));
    assert.equal(j.status, "completed");
    assert.equal(statSync(join(dir, "P-0.flac")).size, 1000);
  });

  it("el progreso de cada pista avanza por trozos", async () => {
    const seen = new Set<number>();
    dl = new Downloader(files as unknown as Transport, fakeBot, dir, settings, () => { const t = job.tracks[0]; if (t) seen.add(t.progress); });
    const job = new DownloadJob("Artista", "Q");
    await dl.runJob(job, album("Q", 1));
    for (const p of [250, 500, 750, 1000]) assert.ok(seen.has(p), `faltó ${p}`);
  });
});

describe("trabajos", () => {
  it("álbum suelto por el bot: busca la ficha y pulsa GET ALL", async () => {
    const j = dl.start("Artista", "S");
    while (j.status === "queued" || j.status === "running") await sleep(10);
    assert.equal(j.status, "completed");
    assert.equal(j.toDict().total, 3);
  });

  it("sin pistas: error con el mensaje del bot; reintentar lo completa en su lugar", async () => {
    emptyOnce.add("Z");
    const z = dl.start("Artista", "Z");
    while (z.status !== "error") await sleep(10);
    assert.match(z.error!, /no envió pistas/);
    await dl.retry(z.id);
    const d = z.toDict();
    assert.equal(z.status, "completed"); assert.equal(d.done, 3); assert.equal(d.intentos, 2); assert.equal(z.error, null);
    assert.throws(() => dl.retry(z.id), (e: Error & { status?: number }) => e.status === 409);
    assert.throws(() => dl.retry("nada"), (e: Error & { status?: number }) => e.status === 404);
  });

  it("turno con el bot: muestra quién espera y el paso de quien tiene el turno", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const a = dl.queue.run("descarga", "Uno", async () => { await gate; });
    const b = dl.queue.run("canciones", "Dos", async () => {});
    await sleep(10);
    const list = dl.queue.list();
    assert.deepEqual(list.map((o) => [o.titulo, o.estado]), [["Uno", "en_curso"], ["Dos", "esperando"]]);
    assert.equal(list[0].paso, "Empezando…");
    release(); await Promise.all([a, b]);
    assert.equal(dl.queue.list().length, 0);
  });
});

describe("ajustes", () => {
  it("guarda y lee ajustes.json; rechaza fuera de 1..5", () => {
    assert.equal(dl.setParallel(4).aviso, undefined);
    assert.equal(dl.slots.limit, 4);
    assert.match(readFileSync(settings, "utf8"), /"descargas_simultaneas": 4/);
    assert.equal(loadSettings(settings).descargas_simultaneas, 4);
    assert.throws(() => dl.setParallel(9), RangeError);
    assert.throws(() => dl.setParallel(0), RangeError);
  });

  it("archivo inexistente, dañado o fuera de rango: 1", () => {
    assert.equal(loadSettings(join(dir, "nada.json")).descargas_simultaneas, 1);
    writeFileSync(settings, "{roto"); assert.equal(loadSettings(settings).descargas_simultaneas, 1);
    writeFileSync(settings, '{"descargas_simultaneas": 7}'); assert.equal(loadSettings(settings).descargas_simultaneas, 1);
  });

  it("lee el ajuste que dejó la versión en Python", () => {
    writeFileSync(settings, '{\n  "descargas_simultaneas": 3\n}');
    const d = new Downloader(files as unknown as Transport, fakeBot, dir, settings);
    assert.equal(d.slots.limit, 3);
  });
});

it("avisa mientras comprueba qué canciones ya están y quita el aviso al terminar", async () => {
  const steps: (string | null)[] = [];
  const job = new DownloadJob("Artista", "E");
  const d = new Downloader(files as unknown as Transport, fakeBot, dir, settings, () => steps.push(job.step));
  writeFileSync(join(dir, "E-0.flac"), "ya estaba");
  await d.runJob(job, album("E", 2));
  assert.ok(steps.includes("Comprobando qué canciones ya tienes en tu carpeta…"));
  assert.equal(job.step, null);
  assert.deepEqual(job.tracks.map((t) => t.status), ["exists", "done"]);
});

it("canción suelta: al reintentar vuelve a pedir la canción, no un álbum", async () => {
  let asks = 0;
  const job = dl.start("Artista", "Tema", 0, async () => (++asks === 1 ? [] : album("T", 1)()));
  while (job.status !== "error") await sleep(5);
  await dl.retry(job.id);
  assert.equal(asks, 2);
  assert.equal(job.status, "completed");
  assert.equal(job.tracks.length, 1);
});
