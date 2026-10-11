/** Búsqueda directa del álbum (inline "álbum artista"): abre la ficha sin recorrer la lista. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { Bot } from "../src/bot.js";
import { cfg } from "../src/config.js";
import { FakeBot } from "./fake-bot.js";

const fast = { ...cfg, quietSeconds: 0, maxWait: 2, pollMs: 0 };

class InlineBot extends FakeBot {
  pressed = 0;
  sent: string[] = [];
  override async pressButton(...a: Parameters<FakeBot["pressButton"]>) { this.pressed++; return super.pressButton(...a); }
  override async inlineQuery() {
    return { queryId: 1, results: [
      { id: "t1", title: "Éxitos tema 1", description: "Artist: Eddy Herrera\nAlbum: Éxitos" },
      { id: "n1", title: "Éxitos (Album)", description: "Magic Juan" },
      { id: "n2", title: "Éxitos (Album)", description: "Eddy Herrera" },
      { id: "n3", title: "Exitos De (Album)", description: "Eddy Herrera" },
    ] };
  }
  override async sendInlineResult(_q?: unknown, id = "") {
    this.sent.push(id);
    Object.assign(this.newMsg(), { out: true, viaBot: true, text: "https://www.deezer.com/album/1" });
    const card = this.newMsg();
    card.text = "💽 Album: Éxitos\n👤 Artist: Eddy Herrera\n🎧 Total tracks: 1";
    card.buttons = [[{ text: "0:04:46 | Eddy Herrera - Mi More", kind: "callback", data: Buffer.from("x") }],
                    [{ text: "GET ALL ⬇️", kind: "callback", data: Buffer.from("y") }]];
  }
}

it("abre el álbum del artista pedido sin pasar por la lista", async () => {
  const fb = new InlineBot(["Otro"], "edit", ["⬅️", "➡️"]);
  const [card] = await new Bot(fb, fast).albumCardId("eddy herrera", "Éxitos");
  assert.equal(fb.msgs.get(card!)!.text.split("\n")[0], "💽 Album: Éxitos");
  assert.deepEqual(fb.sent, ["n2"]);
  assert.equal(fb.pressed, 0);
  const t = await new Bot(fb, fast).albumTracks("Eddy Herrera", "Éxitos");
  assert.deepEqual(t.pistas.map((p) => p.titulo), ["Mi More"]);
  await new Bot(fb, fast).albumCardId("Eddy Herrera", "exitos");   // escrito sin tilde
  assert.deepEqual(fb.sent, ["n2", "n2", "n2"]);
});

it("con el nombre que dio el bot, la búsqueda directa vale aunque se eligiera otro artista (index > 0)", async () => {
  const fb = new InlineBot(["Otro"], "edit", ["⬅️", "➡️"]);
  const [card] = await new Bot(fb, fast).albumCardId("eddy", "Éxitos", 1, "Eddy Herrera");
  assert.ok(card);
  assert.deepEqual(fb.sent, ["n2"]);
  assert.equal(fb.pressed, 0);
});

it("artistas: nombre, álbumes y seguidores de cada resultado, con el índice para elegirlo", async () => {
  class ArtistBot extends FakeBot {
    override async inlineQuery(q?: string) {
      assert.equal(q, ".art soda");
      return { queryId: 1, results: [{ id: "n0", title: "Soda", description: "Albums: 159\nFollowers: 293" },
                                     { id: "n1", title: "Soda Stereo", description: "Albums: 22\nFollowers: 1774511" }] };
    }
  }
  const list = await new Bot(new ArtistBot([], "edit", ["⬅️", "➡️"]), fast).artists("soda");
  assert.deepEqual(list, [{ index: 0, nombre: "Soda", albumes: 159, seguidores: 293 },
                          { index: 1, nombre: "Soda Stereo", albumes: 22, seguidores: 1774511 }]);
});
