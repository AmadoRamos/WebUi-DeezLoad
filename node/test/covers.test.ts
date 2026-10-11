/** Carátulas de Deezer (port de covers.py) con un Deezer falso. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { base, Covers, image, norm } from "../src/covers.js";
import { fakeDeezer } from "./support/stub-bot.js";

it("normaliza títulos como Python", () => {
  assert.equal(norm("Me Verás Volver (Hits & Más)"), "me veras volver hits mas");
  assert.equal(base("De Música Ligera [Remastered 2007]"), "de musica ligera");
  assert.equal(norm(null), "");
});

it("sin imagen: rutas vacías de Deezer", () => {
  assert.equal(image("https://e-cdns-images.dzcdn.net/images/cover//250x250-000000-80-0-0.jpg"), null);
  assert.equal(image("https://cdn/images/artist//x.jpg"), null);
  assert.equal(image("https://cdn/images/cover/abc/250x250.jpg"), "https://cdn/images/cover/abc/250x250.jpg");
});

it("elige al homónimo con los fans más parecidos y recorre las páginas de álbumes", async () => {
  let calls = 0;
  const c = new Covers(async (p, q) => { calls++; return fakeDeezer(p, q); });
  const r = await c.findCovers("Soda Stereo", ["Gira Me Verás Volver", "En el Séptimo Día", "Lo Esencial", "Nada"], 1773909);
  assert.equal(r.artista?.id, 9);
  assert.deepEqual(Object.keys(r.albumes).sort(), ["En el Séptimo Día", "Gira Me Verás Volver", "Lo Esencial"]);
  assert.equal(r.albumes["Lo Esencial"].mediana, null);           // sin carátula
  assert.equal(r.albumes["Gira Me Verás Volver"].explicito, true);
  const before = calls;
  await c.findCovers("Soda Stereo", ["SEP7IMO DIA"], 1773909);  // en caché
  assert.equal(calls, before);
});

it("sin red: resultado vacío con el error; detalles de un álbum que no existe", async () => {
  const c = new Covers(fakeDeezer);
  assert.deepEqual(await c.findCovers("Nadie", ["x"]), { artista: null, albumes: {}, error: "sin red" });
  assert.deepEqual(await c.albumDetails(5), { id: 5, error: "no encontrado" });
  assert.deepEqual((await c.albumDetails(77)).generos, ["Rock", "Latino"]);
});
