/** Biblioteca: artistas y álbumes de la carpeta (por las etiquetas del FLAC) y álbumes incompletos. */
import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Covers } from "../src/covers.js";
import { Library } from "../src/library.js";
import { flacTags } from "../src/songs.js";
import type { Getter } from "../src/covers.js";

/** Deezer falso: «SEP7IMO DIA» tiene 21 pistas; «Alta Suciedad» no está. */
const deezer: Getter = async (path) => {
  if (path === "/search/artist") return { data: [{ id: 9, name: "Soda Stereo" }, { id: 5, name: "Andrés Calamaro" }] };
  if (path.includes("/artist/9/albums")) return { data: [{ id: 77, title: "SEP7IMO DIA" }] };
  if (path === "/album/77") return { id: 77, nb_tracks: 21 };
  return { data: [] };
};

/** Un FLAC mínimo con estas etiquetas. */
function flac(tags: Record<string, string>): Buffer {
  const list = Object.entries(tags).map(([k, v]) => Buffer.from(`${k}=${v}`));
  const vorbis = Buffer.concat([u32(1), Buffer.from("x"), u32(list.length), ...list.flatMap((t) => [u32(t.length), t])]);
  return Buffer.concat([Buffer.from("fLaC"), header(0, 34, false), Buffer.alloc(34), header(4, vorbis.length, true), vorbis]);
}
function u32(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function header(type: number, len: number, last: boolean) { const b = Buffer.alloc(4); b[0] = type | (last ? 0x80 : 0); b.writeUIntBE(len, 1, 3); return b; }

it("lee las etiquetas del FLAC (UTF-8, clave en mayúsculas)", () => {
  const dir = mkdtempSync(join(tmpdir(), "tags-"));
  writeFileSync(join(dir, "a.flac"), flac({ title: "Canción Animal", ALBUM: "Ñandú", TRACKNUMBER: "3/12" }));
  assert.deepEqual(flacTags(join(dir, "a.flac")), { TITLE: "Canción Animal", ALBUM: "Ñandú", TRACKNUMBER: "3/12" });
  writeFileSync(join(dir, "b.mp3"), "ID3");
  assert.equal(flacTags(join(dir, "b.mp3")), null);
});

it("agrupa por artista y álbum, en orden, y marca lo que falta", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lib-"));
  const song = (file: string, tags: Record<string, string>) => writeFileSync(join(dir, file), flac(tags));
  song("Soda Stereo - Signos.flac", { ARTIST: "Soda Stereo", ALBUM: "Signos", TITLE: "Signos", TRACKNUMBER: "2", TRACKTOTAL: "8" });
  song("Soda Stereo - Persiana Americana.flac", { ARTIST: "Soda Stereo", ALBUM: "Signos", TITLE: "Persiana Americana", TRACKNUMBER: "1/8" });
  song("Soda Stereo - Cuando Pase el Temblor.flac", { ARTIST: "Soda Stereo", ALBUM: "SEP7IMO DIA", TITLE: "Cuando Pase el Temblor", TRACKNUMBER: "4" });
  song("Andrés Calamaro - Flaca.flac", { ALBUMARTIST: "Andrés Calamaro", ARTIST: "Andrés Calamaro feat. X", ALBUM: "Alta Suciedad", TITLE: "Flaca" });
  writeFileSync(join(dir, "Soda Stereo - Suelta.mp3"), "ID3");
  writeFileSync(join(dir, "Soda Stereo - Bajando.flac.part"), "");
  writeFileSync(join(dir, "notas.txt"), "");

  const lib = new Library(dir);
  const out = lib.scan();
  assert.deepEqual(out.map((a) => [a.artista, a.canciones]), [["Andrés Calamaro", 1], ["Soda Stereo", 4]]);
  const soda = out[1];
  assert.deepEqual(soda.albumes.map((a) => [a.album, a.canciones.map((c) => c.titulo), a.total, a.faltan]), [
    ["SEP7IMO DIA", ["Cuando Pase el Temblor"], null, 0],
    ["Signos", ["Persiana Americana", "Signos"], 8, 6],
    ["", ["Suelta"], null, 0],   // sin etiquetas: suelta, al final
  ]);

  // Sin TRACKTOTAL: lo pregunta a Deezer
  const res = await lib.checkDeezer(new Covers(deezer));
  assert.deepEqual(res, { revisados: 1, sin_datos: 1 });
  const sep7 = lib.scan()[1].albumes[0];
  assert.deepEqual([sep7.total, sep7.faltan], [21, 20]);

  unlinkSync(join(dir, "Andrés Calamaro - Flaca.flac"));
  assert.deepEqual(lib.scan().map((a) => a.artista), ["Soda Stereo"]);
});
