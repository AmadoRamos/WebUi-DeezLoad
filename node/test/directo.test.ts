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

class SongBot extends FakeBot {
  sent: string[] = [];
  override async inlineQuery(): ReturnType<FakeBot["inlineQuery"]> {
    return { queryId: 1, results: [{ id: "111", title: "Tu Eres Ajena", description: "Artist: Eddy Herrera\nAlbum: Exitos De" },
                                   { id: "n1", title: "Exitos De (Album)", description: "Eddy Herrera" }] };
  }
  override async sendInlineResult(_q?: unknown, id = "") {
    this.sent.push(id);
    Object.assign(this.newMsg(), { out: true, viaBot: true, hasDocument: true,
      media: { kind: "document", size: 1, file_name: "Eddy Herrera - Tu Eres Ajena.flac" } });
  }
}

it("canciones: solo las canciones (no los álbumes), con artista y álbum; elegir una trae su archivo", async () => {
  const fb = new SongBot([], "edit", ["⬅️", "➡️"]);
  const bot = new Bot(fb, fast);
  assert.deepEqual(await bot.songs("tu eres ajena"), [{ id: "111", titulo: "Tu Eres Ajena", artista: "Eddy Herrera", album: "Exitos De" }]);
  const [file] = await bot.songFile("tu eres ajena", "111");
  assert.equal((file.media as { file_name?: string }).file_name, "Eddy Herrera - Tu Eres Ajena.flac");
  assert.deepEqual(fb.sent, ["111"]);
  await assert.rejects(bot.songFile("tu eres ajena", "999"), /ya no muestra esa canción/);
});

it("álbumes por título: los de cualquier artista, sin «(Album)» y aunque vengan recortados", async () => {
  class AlbumBot extends FakeBot {
    override async inlineQuery(): ReturnType<FakeBot["inlineQuery"]> {
      return { queryId: 1, results: [
        { id: "1", title: "Tu Eres Ajena", description: "Artist: Eddy Herrera\nAlbum: Exitos De" },
        { id: "n1", title: "Exitos De (Album)", description: "Eddy Herrera" },
        { id: "n2", title: "Recordar Es Vivir, Vol. 6. Música de Guatemala para…", description: "FM de Zacapa" },
      ] };
    }
  }
  assert.deepEqual(await new Bot(new AlbumBot([], "edit", ["⬅️", "➡️"]), fast).albumSearch("exitos"), [
    { album: "Exitos De", artista: "Eddy Herrera" },
    { album: "Recordar Es Vivir, Vol. 6. Música de Guatemala para…", artista: "FM de Zacapa" },
  ]);
});

it("canción de un álbum: elige la versión de ese álbum entre varias con el mismo título", async () => {
  class VersionsBot extends SongBot {
    override async inlineQuery(): ReturnType<FakeBot["inlineQuery"]> {
      return { queryId: 1, results: [
        { id: "1", title: "Tu Eres Ajena", description: "Artist: Eddy Herrera\nAlbum: Exitos De" },
        { id: "2", title: "Tu Eres Ajena", description: "Artist: Eddy Herrera\nAlbum: Mega MixHits" },
        { id: "3", title: "Tu Eres Ajena", description: "Artist: Frank Reyes\nAlbum: Mega MixHits" },
        { id: "4", title: "TU ERES AJENA (En Vivo)", description: "Artist: Eddy Herrera\nAlbum: Agradecido (Live)" },
      ] };
    }
  }
  const fb = new VersionsBot([], "edit", ["⬅️", "➡️"]);
  const bot = new Bot(fb, fast);
  await bot.albumTrackFile(["", "Eddy Herrera"], "Mega MixHits", "Tu Eres Ajena");
  await bot.albumTrackFile(["Eddy Herrera"], "Agradecido (Live)", "TU ERES AJENA (En Vivo)");
  assert.deepEqual(fb.sent, ["2", "4"]);
  await assert.rejects(bot.albumTrackFile(["Eddy Herrera"], "Otro Disco", "Tu Eres Ajena"), /varias versiones/);
});

it("canciones de la ficha: título, artista y pistas; null si el bot dice más pistas de las que muestra", async () => {
  const fb = new FakeBot([], "edit", ["⬅️", "➡️"]);
  const card = (total: number) => Object.assign(fb.newMsg(), {
    text: `💽 Album: Exitos De\n👤 Artist: Eddy Herrera\n🎧 Total tracks: ${total}`,
    buttons: [["0:05:03 | Eddy Herrera - Pegame Tu Vicio"], ["0:04:52 | Eddy Herrera - Carolina"], ["GET ALL ⬇️"]]
      .map(([text]) => [{ text, kind: "callback" as const, data: Buffer.from(text) }]),
  }).id;
  const bot = new Bot(fb, fast);
  const info = await bot.cardTracks(card(2));
  assert.deepEqual([info?.album, info?.artista, info?.pistas.map((p) => p.titulo)], ["Exitos De", "Eddy Herrera", ["Pegame Tu Vicio", "Carolina"]]);
  assert.equal(await bot.cardTracks(card(14)), null);
});
