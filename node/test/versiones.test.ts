/** Versión explícita / limpia: leer la etiqueta del FLAC y quedarse con la que se quiere. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, it } from "node:test";
import type { Bot } from "../src/bot.js";
import { Discography } from "../src/discography.js";
import { DownloadJob, Downloader, Mutex, versionOfAlbum, type Version } from "../src/downloads.js";
import { explicitOf, find, type FolderIndex } from "../src/songs.js";
import type { Msg, Transport } from "../src/types.js";

/** Un FLAC mínimo como los del bot: STREAMINFO y comentarios con ITUNESADVISORY. */
function flac(advisory: 0 | 1 | null): Buffer {
  const tags = advisory === null ? [] : [`ITUNESADVISORY=${advisory}`];
  const vorbis = Buffer.concat([u32(1), Buffer.from("x"), u32(tags.length), ...tags.flatMap((t) => [u32(t.length), Buffer.from(t)])]);
  return Buffer.concat([Buffer.from("fLaC"), header(0, 34, false), Buffer.alloc(34), header(4, vorbis.length, true), vorbis]);
}
function u32(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function header(type: number, len: number, last: boolean) { const b = Buffer.alloc(4); b[0] = type | (last ? 0x80 : 0); b.writeUIntBE(len, 1, 3); return b; }

let dir: string, downloads: number;
/** Telegram falso: el archivo que llega es la versión que diga el mensaje. */
const files = { async download(m: Msg, path: string) { downloads++; writeFileSync(path, flac(m.raw as 0 | 1)); } } as unknown as Transport;
const song = (advisory: 0 | 1): Msg => ({ id: 1, text: "", buttons: [], out: false, viaBot: true, editDate: 0, hasDocument: true, raw: advisory,
  media: { kind: "document", file_name: "Artista - Uno.flac", title: "Uno", size: 100 } });

async function run(version: Version, have: 0 | 1 | null, arrives: 0 | 1, albumVersion: boolean | null = null) {
  const d = new Downloader(files, {} as Bot, dir, join(dir, "..", "ajustes.json"));
  d.settings.version = version;
  if (have !== null) writeFileSync(join(dir, "Artista - Uno.flac"), flac(have));
  const job = new DownloadJob("Artista", "Uno");
  job.albumVersion = albumVersion;
  await d.runJob(job, async () => [song(arrives)]);
  return { status: job.tracks[0].status, now: explicitOf(join(dir, "Artista - Uno.flac")) };
}

beforeEach(() => { dir = join(mkdtempSync(join(tmpdir(), "ver-")), "dl"); downloads = 0; });

it("lee ITUNESADVISORY del FLAC (null si no es FLAC o no la tiene)", () => {
  const base = mkdtempSync(join(tmpdir(), "flac-"));
  writeFileSync(join(base, "e.flac"), flac(1)); writeFileSync(join(base, "l.flac"), flac(0));
  writeFileSync(join(base, "s.flac"), flac(null)); writeFileSync(join(base, "x.mp3"), "ID3...");
  assert.deepEqual(["e", "l", "s"].map((n) => explicitOf(join(base, `${n}.flac`))), [true, false, null]);
  assert.equal(explicitOf(join(base, "x.mp3")), null);
});

it("quieres la explícita y tienes la limpia: llega la explícita y la sobrescribe", async () => {
  assert.deepEqual(await run("explicita", 0, 1), { status: "done", now: true });
});
it("quieres la explícita y tienes la limpia, pero llega otra vez la limpia: se descarta", async () => {
  assert.deepEqual(await run("explicita", 0, 0), { status: "exists", now: false });
  assert.equal(downloads, 1);
});
it("quieres la limpia y tienes la explícita: la sustituye", async () => {
  assert.deepEqual(await run("limpia", 1, 0), { status: "done", now: false });
});
it("ya tienes la que quieres: ni se baja", async () => {
  assert.deepEqual(await run("explicita", 1, 0), { status: "exists", now: true });
  assert.equal(downloads, 0);
});
it("«cualquiera» (por defecto): la que tengas vale, como antes", async () => {
  assert.deepEqual(await run("cualquiera", 0, 1), { status: "exists", now: false });
  assert.equal(downloads, 0);
});
it("sin la etiqueta no se sabe la versión: no se sustituye a ciegas", async () => {
  assert.deepEqual(await run("explicita", null, 1), { status: "done", now: true });   // no la tenías: se baja
  downloads = 0;
  writeFileSync(join(dir, "Artista - Uno.flac"), flac(null));
  const d = new Downloader(files, {} as Bot, dir, join(dir, "..", "ajustes.json"));
  d.settings.version = "explicita";
  const job = new DownloadJob("Artista", "Uno");
  await d.runJob(job, async () => [song(1)]);
  assert.deepEqual([job.tracks[0].status, downloads, readFileSync(join(dir, "Artista - Uno.flac")).equals(flac(null))], ["exists", 0, true]);
});
it("con las dos versiones en la carpeta, cuenta la que prefieres", () => {
  const idx: FolderIndex = new Map([["uno", [["artista", "Artista - Uno.flac"], ["artista", "Artista - Uno (explícita).flac"]]]]);
  assert.equal(find(idx, "Uno", ["Artista"], (n) => n.includes("explícita")), "Artista - Uno (explícita).flac");
  assert.equal(find(idx, "Uno", ["Artista"]), "Artista - Uno.flac");   // sin preferencia: el primero
});

it("versión del álbum por su nombre: 🅴 explícito; sin 🅴 y de la lista del bot, limpio; si no, no se sabe", () => {
  assert.equal(versionOfAlbum("STANS (The Official Soundtrack) 🅴", false), true);
  assert.equal(versionOfAlbum("STANS (The Official Soundtrack)", true), false);
  assert.equal(versionOfAlbum("STANS (The Official Soundtrack)", false), null);
});
it("quieres la explícita, tienes la limpia y el álbum es limpio: no puede traerla, ni se baja", async () => {
  assert.deepEqual(await run("explicita", 0, 1, false), { status: "exists", now: false });
  assert.equal(downloads, 0);
});
it("quieres la limpia, tienes la explícita y el álbum es explícito (🅴): ni se baja", async () => {
  assert.deepEqual(await run("limpia", 1, 0, true), { status: "exists", now: true });
  assert.equal(downloads, 0);
});
it("quieres la explícita, tienes la limpia y el álbum es explícito: se baja y la sustituye", async () => {
  assert.deepEqual(await run("explicita", 0, 1, true), { status: "done", now: true });
});

it("discografía con las dos versiones de un álbum: solo la que prefieres", () => {
  const titles = ["STANS (The Official Soundtrack) 🅴", "STANS (The Official Soundtrack)", "Curtain Call: The Hits"];
  const pick = (version: Version) => {
    const d = new Downloader(files, {} as Bot, dir, join(dir, "..", "ajustes.json"));
    d.settings.version = version;
    const disc = new Discography("Eminem", "Eminem", 0, titles.map((title) => ({ title })), { bot: {} as never, downloader: d, turn: new Mutex(), pauseSeconds: 0, notify: () => {} });
    return [disc.albums.map((a) => a.title), disc.omitted];
  };
  assert.deepEqual(pick("explicita"), [[titles[0], titles[2]], [titles[1]]]);
  assert.deepEqual(pick("limpia"), [[titles[1], titles[2]], [titles[0]]]);
  assert.deepEqual(pick("cualquiera"), [titles, []]);
});
