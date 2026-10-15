/** Detección de botones, secciones, ficha del álbum y traducción de mensajes reales de GramJS. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { Api } from "telegram";
import bigInt from "big-integer";
import { navKind, parseAlbum, parseSections, safeName } from "../src/bot.js";
import { toMsg } from "../src/telegram.js";

it("navKind", () => {
  const cases: Record<string, string | null> = {
    "Quiero Más": null, "Más": null, "Volver": null, "Back in Black": null, "Next to Me": null, "Independiente": null,
    "More": null, "1/3": null, "GET ALL": null, "Ant": "prev",
    "Next »": "next", "Next": "next", "➡️": "next", "▶": "next", ">>": "next", "Siguiente »": "next", "Más »": "next", "»": "next",
    "« Prev": "prev", "⬅️": "prev", "◀": "prev", "« Anterior": "prev", "<<": "prev",
    "🔙 BACK": "back", "BACK": "back", "🔙 Volver": "back", "❌": "back", "❌ Close": "back",
  };
  for (const [t, want] of Object.entries(cases)) assert.equal(navKind(t), want, t);
});

const page = (rows: string[][], text = "") => ({ message_id: 1, text, buttons: rows.map((r) => r.map((t) => ({ text: t, kind: "callback" as const }))) });

it("parseSections: secciones con separador, sin navegación ni contadores", () => {
  const p1 = page([["SEP7IMO DIA"], ["Gira Me Verás Volver"], ["━━━━", "Singles and EPs", "━━━━"], ["En el Séptimo Día"], ["« Prev", "1/2", "Next »"], ["🔙 BACK"]]);
  const p2 = page([["Quiero Más"], ["GET ALL"], ["0:03:04 | Soda Stereo - Signos"]]);
  assert.deepEqual(parseSections([p1, p2]), { Albums: ["SEP7IMO DIA", "Gira Me Verás Volver"], "Singles and EPs": ["En el Séptimo Día", "Quiero Más"] });
  // Un solo botón "━━ Singles and EPs ━━" no es separador (tiene letras)
  assert.deepEqual(parseSections([page([["A"], ["━━ Singles and EPs ━━"], ["B"]])]), { Albums: ["A", "━━ Singles and EPs ━━", "B"] });
});

it("parseAlbum: ficha y canciones como las del bot real", () => {
  const p = page([["0:03:04 | Soda Stereo - En el Séptimo Día (SEP7IMO DIA)"], ["0:05:20 | Soda Stereo - Cae el Sol / Planta"], ["GET ALL"]],
    "💽 Album: SEP7IMO DIA\n👤 Artist: Soda Stereo\n📅 Date: 2017-03-10\n🎧 Total tracks: 3");
  const d = parseAlbum([p]);
  assert.equal(d.fecha, "2017-03-10");
  assert.deepEqual(d.pistas[1], { n: 2, titulo: "Cae el Sol / Planta", artista: "Soda Stereo", duracion: "0:05:20" });
  assert.equal(d.aviso, "El bot indica 3 pistas y se leyeron 2.");
});

it("safeName: cambia los caracteres no válidos en Windows", () => {
  assert.equal(safeName('Soda Stereo - ¿Por qué?: "x".flac', "f"), "Soda Stereo - ¿Por qué__ _x_.flac");
  assert.equal(safeName("  ", "fallback.bin"), "fallback.bin");
});

it("toMsg: botones y archivo de un mensaje real de GramJS", () => {
  const m = new Api.Message({
    id: 42, peerId: new Api.PeerUser({ userId: bigInt(1) }), date: 0, message: "💽 Album: X", editDate: 7,
    replyMarkup: new Api.ReplyInlineMarkup({ rows: [
      new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonCallback({ text: "GET ALL", data: Buffer.from("ga") })] }),
      new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonSwitchInline({ text: "Buscar", query: ".art " }), new Api.KeyboardButtonUrl({ text: "Web", url: "https://x" })] }),
    ] }),
    media: new Api.MessageMediaDocument({ document: new Api.Document({
      id: bigInt(1), accessHash: bigInt(2), fileReference: Buffer.alloc(0), date: 0, mimeType: "audio/flac", size: bigInt(36935675), dcId: 1,
      attributes: [new Api.DocumentAttributeFilename({ fileName: "Eddy Herrera - Callejon Sin Salida.flac" }),
                   new Api.DocumentAttributeAudio({ duration: 245, title: "Callejon Sin Salida", performer: "Eddy Herrera" })],
    }) }),
  });
  const msg = toMsg(m);
  assert.equal(msg.id, 42); assert.equal(msg.editDate, 7); assert.equal(msg.hasDocument, true);
  assert.deepEqual(msg.buttons.map((r) => r.map((b) => b.kind)), [["callback"], ["switch_inline", "url"]]);
  assert.equal(msg.buttons[0][0].data!.toString(), "ga");
  assert.deepEqual(msg.media, { kind: "document", mime: "audio/flac", size: 36935675, file_name: "Eddy Herrera - Callejon Sin Salida.flac",
                                audio: true, title: "Callejon Sin Salida", performer: "Eddy Herrera", duration: 245 });
});
