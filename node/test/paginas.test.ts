/** Port de test_paginas.py: lista de álbumes paginada, en los dos modos y con 4 estilos de flechas. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Bot, parseSections } from "../src/bot.js";
import { cfg } from "../src/config.js";
import { FakeBot } from "./fake-bot.js";

const TITLES = ["Quiero Más", "Más", "Album 1", "Volver", "Back in Black", "Next to Me",
  ...Array.from({ length: 17 }, (_, i) => `Album ${i + 2}`), "Independiente", "More"];
const fast = { ...cfg, quietSeconds: 0, maxWait: 2, pollMs: 0 };
const NAVS: [string, string][] = [["⬅️", "➡️"], ["« Prev", "Next »"], ["◀", "▶"], ["« Anterior", "Siguiente »"]];

for (const mode of ["edit", "new"] as const) {
  for (const nav of NAVS) {
    describe(`${mode} ${nav.join(" / ")}`, () => {
      it("la lista completa, sin canciones ni botones de página", async () => {
        const fb = new FakeBot(TITLES, mode, nav);
        const bot = new Bot(fb, fast);
        const pages = await bot.allPages(fb.listId);
        assert.deepEqual(Object.values(parseSections(pages)).flat(), TITLES);
      });
      it("abre los 25 álbumes aunque estén en otra página", async () => {
        for (const t of TITLES) {
          const fb = new FakeBot(TITLES, mode, nav);
          const bot = new Bot(fb, fast);
          await bot.allPages(fb.listId);
          const [opened] = await bot.clickInList(fb.listId, t);
          assert.ok(opened.some((m) => m.buttons.flat().some((b) => b.text.endsWith(`- ${t} tema 1`))), t);
        }
      });
      it("exacto antes que parcial: 'Album 1' no abre 'Album 10'", async () => {
        const fb = new FakeBot(TITLES, mode, nav);
        if (mode === "edit") fb.showPage(fb.listId, 1);
        const [opened] = await new Bot(fb, fast).clickInList(fb.listId, "Album 1");
        assert.ok(opened.some((m) => m.buttons.flat().some((b) => b.text.endsWith("- Album 1 tema 1"))));
      });
      it("discografía: canciones de todos los álbumes, volviendo con BACK", async () => {
        const fb = new FakeBot(TITLES, mode, nav);
        const bot = new Bot(fb, fast);
        await bot.allPages(fb.listId);
        let lid = fb.listId;
        for (const t of TITLES) {
          const [data, id] = await bot.albumTracksFromList(lid, t);
          lid = id;
          assert.equal(data.pistas.length, 2, t);
          assert.ok(data.pistas[0].titulo.startsWith(`${t} tema`), t);
        }
      });
      it("GET ALL en serie: ficha y vuelta a la lista, álbum tras álbum", async () => {
        const fb = new FakeBot(TITLES, mode, nav);
        const bot = new Bot(fb, fast);
        await bot.allPages(fb.listId);
        let lid = fb.listId;
        for (const t of TITLES) {
          const [card, id, err] = await bot.albumCardInList(lid, t);
          assert.equal(err, null, t);
          assert.ok(fb.msgs.get(card!)!.buttons.flat().some((b) => b.text.endsWith(`- ${t} tema 1`)), t);
          lid = await bot.backToList(card!, id);
        }
      });
      it("álbum inexistente: error claro", async () => {
        const fb = new FakeBot(TITLES, mode, nav);
        await assert.rejects(new Bot(fb, fast).clickInList(fb.listId, "No Existe"), /No se encontró el álbum 'No Existe'/);
      });
    });
  }
}
