/** Port de test_songs.py + comparación con Python sobre los nombres reales de tu carpeta. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import * as songs from "../src/songs.js";

const k = (n: string) => {
  const i = n.indexOf(" - ");
  return [songs.artistKey(n.slice(0, i)), songs.titleKey(n.slice(i + 3))].join("|");
};

const same: [string, string][] = [
  ["Eddy Herrera - Callejon Sin Salida", "Eddy Herrera - Callejón Sin Salida"],
  ["Eddy Herrera - Demasiado Nina", "Eddy Herrera - Demasiado Niña"],
  ["Eddy Herrera - Seguire Buscandola (Album Version)", "Eddy Herrera - Seguire Buscandola"],
  ["Eddy Herrera - Si Te Vas", "Eddy Herrera - Si Te Vas"],
  ["Eddy Herrera - Su Mirada (Loco, Loco)", "Eddy Herrera - Su Mirada Loco Loco"],
  ["Eddy Herrera - La Sensual (Album Version)", "Eddy Herrera - La Sensual"],
  ["Soda Stereo - De Música Ligera - Remastered 2007", "Soda Stereo - De Musica Ligera"],
  ["Soda Stereo - Persiana Americana [Remasterizado]", "Soda Stereo - Persiana Americana"],
  ["Eddy Herrera feat. Juan Luis Guerra - Algo", "Eddy Herrera - Algo"],
  ["Eddy Herrera - Por qué_", "Eddy Herrera - Por qué?"],
];
const diff: [string, string][] = [
  ["Eddy Herrera - Su Mirada", "Eddy Herrera - Su Mirada Loco Loco"],
  ["Eddy Herrera - Su Mirada", "Eddy Herrera - Tu Mirada"],
  ["Eddy Herrera - Demasiado Romantica", "Eddy Herrera - Demasiado Niña"],
  ["Soda Stereo - Signos (Live)", "Soda Stereo - Signos"],
  ["Soda Stereo - Signos (Remix)", "Soda Stereo - Signos"],
  ["Otro Artista - Si Te Vas", "Eddy Herrera - Si Te Vas"],
];

for (const [a, b] of same) it(`misma canción: ${a} = ${b}`, () => assert.equal(k(a), k(b)));
for (const [a, b] of diff) it(`distinta: ${a} ≠ ${b}`, () => assert.notEqual(k(a), k(b)));

it("los 205 nombres reales de tu carpeta dan las mismas claves que Python", () => {
  const ref: [string, string | null, string | null][] = JSON.parse(readFileSync(new URL("./fixtures/nombres.json", import.meta.url), "utf8"));
  assert.equal(ref.length, 205);
  for (const [name, artist, title] of ref) {
    const parts = songs.splitName(name);
    if (artist === null) { assert.equal(parts, null, name); continue; }
    assert.deepEqual([songs.artistKey(parts![0]), songs.titleKey(parts![1])], [artist, title], name);
  }
});

it("índice de carpeta: ignora temporales y encuentra con otro nombre", () => {
  const dir = mkdtempSync(join(tmpdir(), "songs-"));
  for (const n of ["Eddy Herrera - Callejón Sin Salida.flac", "Eddy Herrera - Nueva.flac.part", "sin formato.flac",
                   "Soda Stereo, Andrea Echeverri - En la Ciudad de la Furia.flac"]) writeFileSync(join(dir, n), "x");
  const idx = songs.folderIndex(dir);
  assert.equal(songs.find(idx, "Callejon sin salida", ["Eddy Herrera"]), "Eddy Herrera - Callejón Sin Salida.flac");
  assert.equal(songs.find(idx, "Callejon sin salida", ["Otro"]), null);
  assert.equal(songs.find(idx, "Nueva", ["Eddy Herrera"]), null);
  assert.equal(songs.find(idx, "En la ciudad de la furia", ["Soda Stereo"]), "Soda Stereo, Andrea Echeverri - En la Ciudad de la Furia.flac");
  assert.equal(songs.folderIndex(join(dir, "no-existe")).size, 0);
});
