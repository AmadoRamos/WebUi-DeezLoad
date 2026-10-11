/** Respaldos ante un bot lento o que responde otra cosa (bot falso con fallos inyectados). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Bot, screenOf, sameAlbum, counterOf, withProgress } from "../src/bot.js";
import { cfg } from "../src/config.js";
import { ResilientTransport, floodSeconds, isTransient } from "../src/resilient.js";
import type { DocInfo, Msg } from "../src/types.js";
import { FlakyBot, type Fault } from "./support/flaky-bot.js";

const SECTIONS = {
  Albums: ["SEP7IMO DIA", "Gira Me Verás Volver", "Lo Esencial", "Obras Cumbres", "Me Verás Volver", "Signos", "Doble Vida"],
  "Singles and EPs": ["En el Séptimo Día", "Persiana Americana (Live)"],
};
const fast = { ...cfg, quietSeconds: 0.05, maxWait: 2, pollMs: 10, slowWait: 0.4, retries: 2,
               filesWait: 0.4, filesGap: 0.3, getAllRetries: 1, maxPages: 40 };

function setup(mode: "edit" | "new", faults: Fault[] = [], opts: ConstructorParameters<typeof FlakyBot>[3] = {}) {
  const fb = new FlakyBot(SECTIONS, mode, faults, opts);
  const bot = new Bot(new ResilientTransport(fb, { retries: 2, floodMax: 5, baseDelayMs: 10 }), fast);
  const steps: string[] = [];
  const run = <T>(fn: () => Promise<T>) => withProgress((s) => steps.push(s), fn);
  const count = (ev: string) => fb.presses.filter((p) => p === ev).length;
  return { fb, bot, steps, run, count };
}
const files = (docs: Msg[]) => docs.map((m) => (m.media as DocInfo).file_name);

for (const mode of ["edit", "new"] as const) {
  describe(`bot ${mode === "edit" ? "que edita el mensaje" : "que manda mensajes nuevos"}`, () => {
    it("la lista tiene su propio GET ALL: no se confunde con un álbum (caso Eddy Herrera)", async () => {
      const c = setup(mode);
      const l = await c.run(() => c.bot.albums("Eddy Herrera"));
      assert.deepEqual("secciones" in l && l.secciones, SECTIONS);
      assert.equal(c.count("back"), 0, "pulsó BACK en la lista");
      assert.equal(c.count("getall-list"), 0, "pulsó el GET ALL de la lista");
      assert.equal(c.count("next"), 2);
    });

    it("sin fallos: lista, canciones y GET ALL", async () => {
      const { bot, run } = setup(mode);
      const l = await run(() => bot.albums("Soda Stereo"));
      assert.deepEqual("secciones" in l && l.secciones, SECTIONS);
      const t = await run(() => bot.albumTracks("Soda Stereo", "Signos"));
      assert.deepEqual(t.pistas.map((p) => p.titulo), ["Signos tema 1", "Signos tema 2", "Signos tema 3"]);
      const { bot: b2 } = setup(mode);
      const [card] = await b2.albumCardId("Soda Stereo", "Doble Vida");
      assert.deepEqual(files(await b2.collectGetAll(card!)), [1, 2, 3].map((i) => `Soda Stereo - Doble Vida tema ${i}.flac`));
    });

    const listCases: [string, Fault[], (c: ReturnType<typeof setup>) => void][] = [
      ["búsqueda lenta (más que el silencio normal)", [{ on: "search", kind: "delay", ms: 300 }], (c) => assert.equal(c.count("search"), 1)],
      ["búsqueda con 'Buscando…' antes de la ficha", [{ on: "search", kind: "loading", ms: 300 }], (c) => assert.equal(c.count("search"), 1)],
      ["la búsqueda no responde: busca otra vez", [{ on: "search", kind: "ignore" }], (c) => {
        assert.equal(c.count("search"), 2);
        assert.ok(c.steps.some((s) => /buscando otra vez/.test(s)));
      }],
      ["ALBUMS no responde: lo pulsa otra vez", [{ on: "albums", kind: "ignore" }], (c) => assert.equal(c.count("albums"), 2)],
      ["ALBUMS lento: espera sin volver a pulsar", [{ on: "albums", kind: "delay", ms: 300 }], (c) => {
        assert.equal(c.count("albums"), 1);
        assert.ok(c.steps.some((s) => /tardando/.test(s)));
      }],
      ["ALBUMS devuelve la ficha del artista (el ejemplo): la vuelve a abrir", [{ on: "albums", kind: "menu" }], (c) => assert.equal(c.count("albums"), 2)],
      ["ALBUMS muestra las canciones de un álbum: BACK y a la lista", [{ on: "albums", kind: "album-card" }], (c) => assert.ok(c.count("back") >= 1)],
      ["'siguiente' no responde: lo pulsa otra vez (hay contador)", [{ on: "next", kind: "ignore" }], (c) => assert.equal(c.count("next"), 3)],
      ["'siguiente' salta dos páginas: vuelve a por la que faltó", [{ on: "next", kind: "double" }], (c) =>
        assert.ok(c.steps.some((s) => /faltan 1 páginas/.test(s)))],
      ["al pasar de página aparece un álbum: empieza de nuevo", [{ on: "next", kind: "album-card" }], (c) => {
        assert.equal(c.count("search"), 2);
        assert.ok(c.steps.some((s) => /Empezando de nuevo/.test(s)));
      }],
      ["error de red al leer el chat: reintenta", [{ on: "getMessages", kind: "error", error: new Error("ECONNRESET: socket hang up"), times: 2 }], (c) =>
        assert.ok(c.steps.some((s) => /Fallo de conexión/.test(s)))],
    ];
    for (const [name, faults, check] of listCases) {
      it(name, async () => {
        const c = setup(mode, faults);
        const l = await c.run(() => c.bot.albums("Soda Stereo"));
        assert.deepEqual("secciones" in l && l.secciones, SECTIONS, JSON.stringify(l));
        assert.equal(c.fb.faults.length, 0, "no se usó el fallo");
        check(c);
      });
    }

    const albumCases: [string, Fault[]][] = [
      ["abre otro álbum: vuelve a la lista y abre el correcto", [{ on: "album", kind: "wrong-album" }]],
      ["al abrir el álbum aparece la ficha del artista", [{ on: "album", kind: "menu" }]],
      ["el álbum no responde: lo pulsa otra vez", [{ on: "album", kind: "ignore" }]],
      ["el álbum tarda", [{ on: "album", kind: "delay", ms: 300 }]],
    ];
    for (const [name, faults] of albumCases) {
      it(name, async () => {
        const c = setup(mode, faults);
        const t = await c.run(() => c.bot.albumTracks("Soda Stereo", "Signos"));
        assert.deepEqual(t.pistas.map((p) => p.titulo), ["Signos tema 1", "Signos tema 2", "Signos tema 3"]);
        assert.equal(c.fb.faults.length, 0, "no se usó el fallo");
      });
    }

    it("GET ALL sin respuesta: lo pide otra vez", async () => {
      const c = setup(mode, [{ on: "getall", kind: "ignore" }]);
      const [card] = await c.run(() => c.bot.albumCardId("Soda Stereo", "Signos"));
      const docs = await c.run(() => c.bot.collectGetAll(card!));
      assert.equal(docs.length, 3);
      assert.equal(c.count("getall"), 2);
    });

    it("GET ALL con archivos repetidos: cada pista una vez", async () => {
      const c = setup(mode, [{ on: "getall", kind: "duplicate" }]);
      const [card] = await c.bot.albumCardId("Soda Stereo", "Signos");
      assert.deepEqual(files(await c.bot.collectGetAll(card!)), [1, 2, 3].map((i) => `Soda Stereo - Signos tema ${i}.flac`));
    });

    it("discografía con fallos mezclados: cada álbum con sus pistas", async () => {
      const c = setup(mode, [
        { on: "album", kind: "wrong-album" }, { on: "back", kind: "menu" }, { on: "getall", kind: "ignore" },
        { on: "next", kind: "ignore" }, { on: "album", kind: "delay", ms: 300 }, { on: "back", kind: "ignore" },
      ]);
      const l = await c.bot.albums("Soda Stereo");
      assert.ok("list_message_id" in l);
      let listId = l.list_message_id;
      for (const title of Object.values(SECTIONS).flat()) {
        const [card, id, err] = await c.run(() => c.bot.albumCardInList(listId, title));
        assert.equal(err, null, title);
        assert.ok(sameAlbum(c.fb.msgs.get(card!)!, title), title);
        const docs = await c.run(() => c.bot.collectGetAll(card!));
        assert.deepEqual(files(docs), [1, 2, 3].map((i) => `Soda Stereo - ${title} tema ${i}.flac`), title);
        listId = await c.run(() => c.bot.backToList(card!, id));
        assert.equal(screenOf(c.fb.msgs.get(listId)!), "list", title);
      }
      // Si el bot manda mensajes nuevos, la lista sigue a la vista y no hace falta BACK.
      const unused = c.fb.faults.filter((f) => !(mode === "new" && f.on === "back"));
      assert.deepEqual(unused, [], "quedaron fallos sin usar");
    });

    it("el bot nunca responde a ALBUMS: error claro y en poco tiempo", async () => {
      const c = setup(mode, [{ on: "albums", kind: "ignore", times: 99 }]);
      const t0 = Date.now();
      const l = await c.bot.albums("Soda Stereo");
      assert.match((l as { error: string }).error, /no respondió al abrir la lista/);
      assert.ok(Date.now() - t0 < 2500, `tardó ${Date.now() - t0} ms`);   // 3 pulsaciones, sin volver a buscar
      assert.equal(c.count("search"), 1);
      assert.equal(c.count("albums"), 3);
    });

    it("sin contador y con una flecha muerta en la última página: termina rápido", async () => {
      const c = setup(mode, [], { counter: false, deadNext: true });
      const t0 = Date.now();
      const l = await c.bot.albums("Soda Stereo");
      assert.deepEqual("secciones" in l && l.secciones, SECTIONS);
      assert.ok(Date.now() - t0 < 3000, `tardó ${Date.now() - t0} ms`);
    });
  });
}

describe("pantallas y errores", () => {
  const m = (text: string, rows: string[][], extra: Partial<Msg> = {}) =>
    ({ text, buttons: rows.map((r) => r.map((t) => ({ text: t, kind: "callback" as const }))), hasDocument: false, ...extra });
  it("reconoce cada pantalla", () => {
    assert.equal(screenOf(m("👤 Artist: X", [["🔝 TOP 30", "💽 ALBUMS"]])), "menu");
    assert.equal(screenOf(m("👤 Artist: X", [["ALBUMS (22)"], ["❌ CLOSE"]])), "menu");
    assert.equal(screenOf(m("x", [["Albums"], ["1/3", "➡️"]])), "list");         // un álbum llamado "Albums"
    assert.equal(screenOf(m("x", [["Greatest Albums"], ["Otro"]])), "list");
    assert.equal(screenOf(m("💽 Album: X", [["0:03:01 | A - B"], ["GET ALL"]])), "album");
    // La lista del bot tiene GET ALL y el texto del artista: es la lista, no un álbum.
    assert.equal(screenOf(m("👤 Artist: Eddy Herrera\n💽 Albums numbers: 40", [["⬇️ GET ALL"], ["Quiero Más"], ["1/4", "➡️"], ["🔙 BACK"]])), "list");
    assert.equal(screenOf(m("", [["GET ALL"], ["Independiente"], ["Mi Historia"]])), "list");
    // Ficha de álbum con las canciones detrás de otro botón: GET ALL + texto de ficha.
    assert.equal(screenOf(m("💽 Album: X\n🎧 Total tracks: 12", [["🎵 TRACKS"], ["GET ALL"], ["🔙 BACK"]])), "album");
    assert.equal(screenOf(m("📀 X\n🎧 Total tracks: 12", [["GET ALL"]])), "album");
    assert.equal(screenOf(m("⏳ Buscando…", [])), "empty");
    assert.equal(screenOf(m("", [], { hasDocument: true })), "files");
  });
  it("contador y álbum correcto", () => {
    assert.deepEqual(counterOf(m("", [["⬅️", "2 de 5", "➡️"]])), [2, 5]);
    assert.equal(counterOf(m("", [["Signos"]])), null);
    assert.ok(sameAlbum(m("💽 Album: Me Verás Volver (Hits & Más)", []), "Me Verás Volver (Hits & Más)"));
    assert.ok(sameAlbum(m("💽 Album: Me Verás Volver (Hits & Más)", []), "Me Verás Volver (Hits…"));   // botón recortado
    assert.ok(!sameAlbum(m("💽 Album: Signos", []), "Doble Vida"));
    assert.ok(sameAlbum(m("💿 Signos", []), "Doble Vida"));                                       // la ficha no dice el título
  });
  it("errores pasajeros y esperas de Telegram", () => {
    assert.ok(isTransient(new Error("ECONNRESET")));
    assert.ok(isTransient(Object.assign(new Error("RPC"), { code: -503 })));
    assert.ok(!isTransient(new Error("MESSAGE_ID_INVALID")));
    assert.equal(floodSeconds(new Error("420: FLOOD_WAIT_35 (caused by messages.GetBotCallbackAnswer)")), 35);
    assert.equal(floodSeconds(Object.assign(new Error("A wait of 12 seconds is required (FloodWaitError)"), { seconds: 12 })), 12);
    assert.equal(floodSeconds(new Error("otra cosa")), null);
  });
  it("FLOOD_WAIT al pulsar: espera lo pedido y sigue", async () => {
    const c = setup("edit", [{ on: "pressButton", kind: "error", error: new Error("FLOOD_WAIT_0") }]);
    const l = await c.run(() => c.bot.albums("Soda Stereo"));
    assert.deepEqual("secciones" in l && l.secciones, SECTIONS);
    assert.ok(c.steps.some((s) => /Telegram pide esperar 0 s/.test(s)));
  });
  it("descarga cortada por la red: se repite desde cero", async () => {
    let calls = 0;
    const seen: number[] = [];
    const t = new ResilientTransport({ download: async (_m: Msg, _p: string, cb?: (r: number, t: number) => void) => {
      calls++; cb?.(500, 1000);
      if (calls === 1) throw new Error("Connection closed");
      cb?.(1000, 1000);
    } } as never, { retries: 2, floodMax: 5, baseDelayMs: 5 });
    await t.download({} as Msg, "/tmp/x", (r) => seen.push(r));
    assert.equal(calls, 2);
    assert.deepEqual(seen, [500, 0, 500, 1000]);
  });
});
