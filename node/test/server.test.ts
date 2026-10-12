/** Servidor web: rutas, avisos en vivo (SSE) y cierre, con el doble del bot. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";
import { Covers } from "../src/covers.js";
import { App } from "../src/server.js";
import { StubBot, fakeDeezer } from "./support/stub-bot.js";

let app: App, base: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
before(async () => {
  const root = mkdtempSync(join(tmpdir(), "web-"));
  mkdirSync(join(root, "webui"));
  writeFileSync(join(root, "webui", "index.html"), "<!doctype html><title>deezload</title>");
  const stub = new StubBot(0.02);
  app = new App({ transport: stub.transport(), bot: stub as never, covers: new Covers(fakeDeezer), botName: "deezload2bot",
                  downloadsDir: join(root, "dl"), settingsFile: join(root, "ajustes.json"), webui: join(root, "webui"),
                  discPause: 0, eventBatchMs: 50, eventPingMs: 300 });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(() => app.close());

const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Lee eventos SSE de una conexión abierta. */
async function sse(ms: number) {
  const ac = new AbortController();
  const r = await fetch(base + "/api/eventos", { signal: ac.signal });
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  const stop = setTimeout(() => ac.abort(), ms);
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); } }
  catch { /* cortado por el temporizador */ }
  clearTimeout(stop);
  const events = [...text.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)].map((m) => [m[1], JSON.parse(m[2])] as const);
  return { text, events, pings: text.split(": ping").length - 1 };
}

it("página principal y configuración", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /text\/html/);
  assert.equal((await (await fetch(base + "/api/config")).json()).bot, "deezload2bot");
});

it("SSE: 'estado' con todo al conectar, 'cambios' solo con lo que cambió y ping sin cambios", async () => {
  const listening = sse(2500);
  await sleep(100);
  const { job_id } = await (await post("/api/download", { artist: "Soda Stereo", album: "SEP7IMO DIA" })).json();
  const { events, pings, text } = await listening;
  assert.ok(text.startsWith("retry: 3000\n\n"));
  assert.equal(events[0][0], "estado");
  assert.deepEqual(Object.keys(events[0][1]).sort(), ["actividad", "ahora", "ajustes", "discografias", "jobs"]);
  const changes = events.slice(1);
  assert.ok(changes.length >= 3, `pocos cambios: ${changes.length}`);
  assert.ok(changes.every(([name]) => name === "cambios"));
  // cada 'cambios' trae solo las partes que cambiaron (nunca un aviso vacío)
  assert.ok(changes.every(([, d]) => Object.keys(d).length > 1 && !("ajustes" in d)));
  const last = changes.filter(([, d]) => d.jobs?.length).at(-1)![1].jobs[0];
  assert.equal(last.id, job_id);
  assert.equal(last.status, "completed");
  assert.ok(pings >= 1, "sin ping tras quedar en silencio");
  // ráfagas agrupadas: muchos avisos de progreso, pocos mensajes
  assert.ok(changes.length < 40, `demasiados mensajes: ${changes.length}`);
});

it("ajustes por SSE y archivo ajustes.json", async () => {
  const listening = sse(600);
  await sleep(100);
  assert.equal((await post("/api/ajustes", { descargas_simultaneas: 3 })).status, 200);
  const { events } = await listening;
  assert.deepEqual(events.find(([n, d]) => n === "cambios" && d.ajustes)?.[1].ajustes, { descargas_simultaneas: 3, version: "cualquiera", maximo: 5 });
  // con qué versión quedarse: se guarda sin tocar las descargas simultáneas
  assert.equal((await (await post("/api/ajustes", { version: "explicita" })).json()).version, "explicita");
  assert.equal((await post("/api/ajustes", { version: "otra" })).status, 422);
  assert.equal((await (await fetch(`${base}/api/ajustes`)).json()).descargas_simultaneas, 3);
});

it("álbum en la cola de una discografía: 409; otro artista con el mismo álbum: sí", async () => {
  const { id } = await (await post("/api/discografias", { artist: "Artista", albums: [{ title: "G1" }, { title: "Ñandú (Album Version)" }] })).json();
  const r = await post("/api/download", { artist: "artista", album: "Nandu" });
  assert.equal(r.status, 409);
  assert.match((await r.json()).detail, /cola/);
  assert.equal((await post("/api/download", { artist: "Otro", album: "G1" })).status, 200);
  assert.equal((await (await post(`/api/discografias/${id}/pausar`, {})).json()).pausando, true);
  assert.equal((await (await post(`/api/discografias/${id}/cancelar`, {})).json()).cancelando, true);
});

it("cuerpo que no es JSON: 422", async () => {
  const r = await fetch(base + "/api/download", { method: "POST", body: "{roto" });
  assert.equal(r.status, 422);
});

it("cerrar el servidor corta las conexiones SSE al instante", async () => {
  const listening = sse(10_000);
  await sleep(100);
  const t0 = Date.now();
  await app.close();
  await listening;
  assert.ok(Date.now() - t0 < 1500, `tardó ${Date.now() - t0} ms`);
});
