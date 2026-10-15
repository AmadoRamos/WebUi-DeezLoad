/** Historial: las descargas y discografías siguen ahí tras reiniciar, y lo que se cortó se retoma. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Covers } from "../src/covers.js";
import { App } from "../src/server.js";
import { StubBot, fakeDeezer } from "./support/stub-bot.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function open(root: string) {
  mkdirSync(join(root, "webui"), { recursive: true });
  writeFileSync(join(root, "webui", "index.html"), "<!doctype html>");
  const stub = new StubBot(0.01);
  const app = new App({ transport: stub.transport(), bot: stub as never, covers: new Covers(fakeDeezer), botName: "bot",
                        downloadsDir: join(root, "dl"), settingsFile: join(root, "ajustes.json"), webui: join(root, "webui"),
                        discPause: 0, eventBatchMs: 20, eventPingMs: 300 });
  await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const get = async (p: string) => (await fetch(base + p)).json();
  const post = async (p: string, body: unknown = {}) =>
    (await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  /** Espera a que no quede nada en curso. */
  const idle = async () => {
    for (let i = 0; i < 400; i++) {
      const [jobs, discs] = await Promise.all([get("/api/jobs"), get("/api/discografias")]);
      if (jobs.every((j: { status: string }) => j.status === "completed" || j.status === "error")
          && discs.every((d: { status: string }) => d.status === "completed" || d.status === "canceled")) return { jobs, discs };
      await sleep(50);
    }
    throw new Error("no terminó");
  };
  return { app, stub, get, post, idle };
}

it("lo descargado sigue en la lista tras reiniciar (también una canción suelta)", async () => {
  const root = mkdtempSync(join(tmpdir(), "hist-"));
  const a = await open(root);
  await a.post("/api/cancion", { q: "furia", id: "11", titulo: "En la Ciudad de la Furia", artista: "Soda Stereo" });
  await a.post("/api/download", { artist: "Soda Stereo", album: "SEP7IMO DIA" });
  const before = (await a.idle()).jobs;
  await a.app.close();
  assert.ok(existsSync(join(root, "historial.json")));

  const b = await open(root);
  const after = await b.get("/api/jobs");
  assert.deepEqual(after.map((j: { id: string; status: string; total: number }) => [j.id, j.status, j.total]),
                   before.map((j: { id: string; status: string; total: number }) => [j.id, j.status, j.total]));
  const saved = JSON.parse(readFileSync(join(root, "historial.json"), "utf8"));
  assert.deepEqual(saved.jobs.find((j: { album: string }) => j.album === "En la Ciudad de la Furia").source,
                   { tipo: "cancion", q: "furia", id: "11" });

  // Limpiar: se quita lo terminado y la lista se vacía también tras reiniciar
  await b.post("/api/jobs/limpiar");
  assert.deepEqual(await b.get("/api/jobs"), []);
  await b.app.close();
  const c = await open(root);
  assert.deepEqual(await c.get("/api/jobs"), []);
  await c.app.close();
});

it("al arrancar retoma lo que se cortó: descargas sueltas y discografías (sin repetir lo listo)", async () => {
  const root = mkdtempSync(join(tmpdir(), "hist-"));
  const job = (id: string, album: string, extra = {}) => ({ id, seq: 5, artist: "Soda Stereo", album, index: 0, status: "running",
    error: null, tracks: [], created: 1, finished: null, step: "Pidiendo…", attempts: 1, albumVersion: null, discography: null, source: null, ...extra });
  writeFileSync(join(root, "historial.json"), JSON.stringify({
    jobs: [
      job("suelta", "En la Ciudad de la Furia", { source: { tipo: "cancion", q: "furia", id: "11" } }),
      job("d1", "SEP7IMO DIA", { status: "completed", discography: "disc", finished: 2 }),
      job("d2", "Lo Esencial", { discography: "disc" }),
    ],
    discografias: [{ id: "disc", artist: "Soda Stereo", name: "Soda Stereo", index: 0, omitted: [], status: "running", created: 1,
      finished: null, cancelRequested: false, albums: [
        { title: "SEP7IMO DIA", section: "Albums", status: "completed", job_id: "d1", error: null },
        { title: "Lo Esencial", section: "Albums", status: "running", job_id: "d2", error: null },
        { title: "Gira Me Verás Volver", section: "Albums", status: "pending", job_id: null, error: null },
      ] }],
  }));
  const a = await open(root);
  const { jobs, discs } = await a.idle();
  const byId = new Map(jobs.map((j: { id: string }) => [j.id, j]));
  assert.equal((byId.get("suelta") as { status: string }).status, "completed");
  assert.equal((byId.get("suelta") as { intentos: number }).intentos, 2);
  assert.equal((byId.get("d2") as { status: string }).status, "completed");   // el mismo trabajo, otra vez
  assert.deepEqual(discs[0].albums.map((x: { status: string }) => x.status), ["completed", "completed", "completed"]);
  assert.equal(discs[0].status, "completed");
  await a.app.close();
  // SEP7IMO DIA no se volvió a abrir («Gira…» dos veces: el doble corta una pista la primera vez)
  assert.deepEqual([...new Set(a.stub.cards.values())].sort(), ["Gira Me Verás Volver", "Lo Esencial"]);
});

it("una discografía en pausa sigue en pausa al reiniciar", async () => {
  const root = mkdtempSync(join(tmpdir(), "hist-"));
  writeFileSync(join(root, "historial.json"), JSON.stringify({ jobs: [], discografias: [{ id: "p", artist: "Soda Stereo", name: "Soda Stereo",
    index: 0, omitted: [], status: "paused", created: 1, finished: null, cancelRequested: false,
    albums: [{ title: "Lo Esencial", section: "", status: "pending", job_id: null, error: null }] }] }));
  const a = await open(root);
  await sleep(200);
  assert.equal((await a.get("/api/discografias"))[0].status, "paused");
  assert.equal(a.stub.cards.size, 0);
  await a.post("/api/discografias/p/reanudar");
  assert.equal((await a.idle()).discs[0].albums[0].status, "completed");
  await a.app.close();
});
