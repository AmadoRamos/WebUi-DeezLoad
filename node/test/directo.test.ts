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
