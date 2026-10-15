/** «Para después», importar listas de canciones y discos nuevos de los artistas que sigues. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Covers, type Getter } from "../src/covers.js";
import { parseList } from "../src/importer.js";
import { App } from "../src/server.js";
import { StubBot } from "./support/stub-bot.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deezer falso: «Soda Stereo» (id 9) con los lanzamientos de `albums` (se pueden añadir). */
function deezer(albums: { id: number; title: string; explicit_lyrics?: boolean }[]): Getter {
  return async (path) => {
    if (path === "/search/artist") return { data: [{ id: 9, name: "Soda Stereo", nb_fan: 100 }] };
    if (path.includes("/artist/9/albums")) return { data: albums.map((a) => ({ record_type: "album", release_date: "2026-10-01", ...a })) };
    return { data: [] };
  };
}

async function open(covers = new Covers(deezer([]))) {
  const root = mkdtempSync(join(tmpdir(), "listas-"));
  mkdirSync(join(root, "webui"));
  writeFileSync(join(root, "webui", "index.html"), "<!doctype html>");
  const stub = new StubBot(0.01);
  const app = new App({ transport: stub.transport(), bot: stub as never, covers, botName: "bot", downloadsDir: join(root, "dl"),
                        settingsFile: join(root, "ajustes.json"), webui: join(root, "webui"), discPause: 0 });
  await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const get = async (p: string) => (await fetch(base + p)).json();
  const post = async (p: string, body: unknown = {}) =>
    (await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const done = async () => {
    for (let i = 0; i < 400; i++) {
      const jobs = await get("/api/jobs");
      if (jobs.every((j: { status: string }) => j.status === "completed" || j.status === "error")) return jobs;
      await sleep(50);
    }
    throw new Error("no terminó");
  };
  return { app, root, get, post, done };
}

it("entiende listas «Artista - Título», numeradas, sin artista y CSV de Spotify", () => {
  assert.deepEqual(parseList("Soda Stereo - Signos\n\n1. Charly García – Demoliendo Hoteles\n# comentario\nDe Música Ligera\n---"), {
    canciones: [{ artista: "Soda Stereo", titulo: "Signos" }, { artista: "Charly García", titulo: "Demoliendo Hoteles" },
                { artista: "", titulo: "De Música Ligera" }],
    no_entendidas: ["---"],
  });
  const csv = '"Track URI","Track Name","Artist Name(s)"\n"x","Persiana Americana","Soda Stereo"\n"y","Crimen, Remix","Gustavo Cerati, Otro"\n"z","",""';
  assert.deepEqual(parseList(csv), {
    canciones: [{ artista: "Soda Stereo", titulo: "Persiana Americana" }, { artista: "Gustavo Cerati", titulo: "Crimen, Remix" }],
    no_entendidas: ['"z","",""'],
  });
  assert.deepEqual(parseList("Título;Artista\nFlaca;Andrés Calamaro").canciones, [{ artista: "Andrés Calamaro", titulo: "Flaca" }]);
});

it("para después: apuntar (sin repetir), descargar y a su hora una vez al día", async () => {
  const t = await open();
  const a = await t.post("/api/deseos", { tipo: "album", artista: "Soda Stereo", titulo: "SEP7IMO DIA", lista: true });
  assert.equal((await t.post("/api/deseos", { tipo: "album", artista: "soda stereo", titulo: "Sep7imo Dia" })).id, a.id);
  await t.post("/api/deseos", { tipo: "cancion", artista: "Tributo Rock", titulo: "En la Ciudad de la Furia" });
  assert.equal((await t.get("/api/deseos")).length, 2);
  assert.equal((await t.post("/api/deseos/accion", { accion: "descargar", ids: [a.id] })).jobs.length, 1);
  assert.deepEqual((await t.get("/api/deseos")).map((w: { tipo: string }) => w.tipo), ["cancion"]);

  // A su hora: solo si está activada, y una vez al día
  await t.app.tick(new Date(2026, 9, 15, 3));
  assert.equal((await t.get("/api/deseos")).length, 1);
  await t.post("/api/ajustes", { deseos_hora: 3 });
  await t.app.tick(new Date(2026, 9, 15, 3, 1));
  assert.equal((await t.get("/api/deseos")).length, 0);
  const jobs = await t.done();
  assert.deepEqual(jobs.map((j: { album: string; status: string }) => [j.album, j.status]).sort(),
                   [["En la Ciudad de la Furia", "completed"], ["SEP7IMO DIA", "completed"]]);
  await t.post("/api/deseos", { tipo: "album", artista: "Soda Stereo", titulo: "Lo Esencial" });
  await t.app.tick(new Date(2026, 9, 15, 3, 30));
  assert.equal((await t.get("/api/deseos")).length, 1);   // hoy ya se hizo
  await t.app.close();
});

it("importar: salta las que ya tienes y las repetidas; busca cada una en el bot", async () => {
  const t = await open();
  mkdirSync(join(t.root, "dl"), { recursive: true });
  writeFileSync(join(t.root, "dl", "Soda Stereo - En la Ciudad de la Furia.flac"), "x");
  const r = await t.post("/api/importar", { texto: "Soda Stereo - En la ciudad de la furia\nTributo Rock - En la Ciudad de la Furia\n"
    + "tributo rock - En la Ciudad de la Furia\nNadie - Nada" });
  assert.deepEqual([r.anadidas, r.ya_tienes.length, r.repetidas, r.no_entendidas.length], [2, 1, 1, 0]);
  const jobs = await t.done();
  const byTitle = new Map(jobs.map((j: { album: string }) => [j.album, j]));
  assert.equal((byTitle.get("En la Ciudad de la Furia") as { status: string }).status, "completed");
  assert.match((byTitle.get("Nada") as { error: string }).error, /no encontró «Nada» de Nadie/);
  // A «para después» en lugar de descargar
  assert.equal((await t.post("/api/importar", { texto: "Charly García - Yendo de la Cama al Living", destino: "deseos" })).anadidas, 1);
  assert.equal((await t.get("/api/deseos"))[0].titulo, "Yendo de la Cama al Living");
  await t.app.close();
});

it("novedades: al seguir no hay nada nuevo; lo que sale después aparece y se puede apuntar o descargar solo", async () => {
  const albums: { id: number; title: string; explicit_lyrics?: boolean }[] = [{ id: 1, title: "SEP7IMO DIA" }];
  const t = await open(new Covers(deezer(albums)));
  const f = await t.post("/api/seguidos", { artista: "Soda Stereo" });
  assert.deepEqual(f.artistas.map((a: { nombre: string }) => a.nombre), ["Soda Stereo"]);
  assert.equal((await t.post("/api/seguidos/revisar")).encontrados, 0);

  albums.push({ id: 2, title: "Lo Esencial" });
  const r = await t.post("/api/seguidos/revisar");
  assert.deepEqual(r.novedades.map((n: { album: string }) => n.album), ["Lo Esencial"]);
  assert.equal((await t.post("/api/seguidos/revisar")).encontrados, 0);   // ya no es nueva
  await t.post("/api/novedades", { accion: "despues", ids: [2] });
  assert.deepEqual((await t.get("/api/deseos")).map((w: { titulo: string }) => w.titulo), ["Lo Esencial"]);
  assert.equal((await t.get("/api/seguidos")).novedades.length, 0);

  // Descargar solas: de la versión explícita y la limpia del mismo disco, solo la que prefieres
  await t.post("/api/ajustes", { novedades: "descargar", version: "explicita" });
  albums.push({ id: 3, title: "Gira Me Verás Volver", explicit_lyrics: false }, { id: 4, title: "Gira Me Verás Volver", explicit_lyrics: true });
  assert.equal((await t.post("/api/seguidos/revisar")).encontrados, 2);
  assert.equal((await t.get("/api/seguidos")).novedades.length, 0);
  const jobs = await t.get("/api/jobs");
  assert.deepEqual(jobs.map((j: { album: string }) => j.album), ["Gira Me Verás Volver"]);
  await t.done();

  await t.post("/api/seguidos/9/dejar");
  assert.equal((await t.get("/api/seguidos")).artistas.length, 0);
  await t.app.close();
});
