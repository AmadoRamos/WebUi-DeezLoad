/** Doble del bot para probar el servidor (mismo comportamiento que el doble de Python de las
 *  pruebas e2e: formato de datos y demoras parecidos al bot real, sin Telegram). */
import { writeFileSync } from "node:fs";
import { report } from "../../src/bot.js";
import type { Getter } from "../../src/covers.js";
import type { Msg, Transport } from "../../src/types.js";

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
export const SECC = { Albums: ["SEP7IMO DIA", "Gira Me Verás Volver", "Lo Esencial", "Obras Cumbres"], "Singles and EPs": ["En el Séptimo Día"] };

export class StubBot {
  cards = new Map<number, string>();
  emptyOnce = new Set<string>();
  failed = new Set<string>();
  constructor(public speed = 1) {}
  private wait(s: number) { return sleep(s * this.speed); }
  private async listing(artist: string) {
    report(`Buscando a «${artist}» en el bot`); await this.wait(0.8);
    report("Abriendo la lista de álbumes"); await this.wait(0.5);
    for (const n of [1, 2]) { report(`Leyendo la lista de álbumes: página ${n}`); await this.wait(0.3); }
  }
  async albumSearch(_q: string) {
    await this.wait(0.3);
    return [{ album: "SEP7IMO DIA", artista: "Soda Stereo" }, { album: "Lo Esencial", artista: "Soda Stereo" }, { album: "Lo Esencial", artista: "Otro Artista" }];
  }
  async songs(_q: string) {
    await this.wait(0.3);
    return [{ id: "11", titulo: "En la Ciudad de la Furia", artista: "Soda Stereo", album: "Doble Vida" },
            { id: "12", titulo: "En la Ciudad de la Furia", artista: "Tributo Rock", album: "Homenaje" }];
  }
  async songFile(_q: string, id: string): Promise<Msg[]> {
    report("Pidiendo la canción al bot"); await this.wait(0.5);
    const artist = id === "11" ? "Soda Stereo" : "Tributo Rock";
    return [{ id: 2000 + Number(id), text: "", buttons: [], out: false, viaBot: true, editDate: 0, hasDocument: true, raw: { album: `cancion ${id}`, i: 0 },
              media: { kind: "document", size: 3_000_000, file_name: `${artist} - En la Ciudad de la Furia.flac`, title: "En la Ciudad de la Furia" } }];
  }
  async artists(_q: string) {
    await this.wait(0.3);
    return [{ index: 0, nombre: "Soda", albumes: 159, seguidores: 293 }, { index: 1, nombre: "Soda", albumes: 41, seguidores: 2 },
            { index: 2, nombre: "Soda Stereo", albumes: 22, seguidores: 1774511 }];
  }
  async albums(artist: string, _index = 0) {
    await this.listing(artist);
    return { artista: "👤 Artist: Soda Stereo\n💽 Albums numbers: 22\n👥 Fans on Deezer: 1773909", total: 5, secciones: SECC, list_message_id: 1 };
  }
  async albumTracks(artist: string, album: string, _index = 0) {
    await this.listing(artist); report(`Abriendo «${album}»`); await this.wait(0.4);
    return { artista: artist, album, fecha: "2017-03-10",
             pistas: [0, 1, 2].map((i) => ({ n: i + 1, titulo: `${album} - Tema ${i + 1}`, artista: "Soda Stereo", duracion: `0:03:1${i}` })) };
  }
  async albumCardInList(listId: number, title: string): Promise<[number | null, number, string | null]> {
    report(`Abriendo «${title}»`); await this.wait(0.4);
    if (title === "Obras Cumbres") return [null, listId, "El bot no mostró el botón 'GET ALL' para este álbum."];
    const id = 100 + this.cards.size;
    this.cards.set(id, title);
    return [id, listId, null];
  }
  async albumCardDirect(_artist: string, _album: string): Promise<number | null> { return null; }  // usa la lista
  async backToList(_card: number, listId: number) { report("Volviendo a la lista de álbumes"); await this.wait(0.2); return listId; }
  async albumCardId(artist: string, album: string, _index = 0): Promise<[number | null, Record<string, unknown> | null]> {
    await this.listing(artist);
    const [id, , err] = await this.albumCardInList(1, album);
    return id !== null ? [id, null] : [null, { error: err }];
  }
  async collectGetAll(card: number): Promise<Msg[]> {
    const title = this.cards.get(card)!;
    report("Pidiendo las pistas al bot (GET ALL)"); await this.wait(0.6);
    if (this.emptyOnce.has(title)) { this.emptyOnce.delete(title); return []; }
    return [0, 1, 2, 3].map((i) => ({
      id: 1000 + i, text: "", buttons: [], out: false, viaBot: false, editDate: 0, hasDocument: true, raw: { album: title, i },
      media: { kind: "document", size: 3_000_000, file_name: `Soda Stereo - ${title} - Tema ${i + 1}.flac`, title: `${title} - Tema ${i + 1}` },
    }));
  }
  /** La parte de Telegram que baja archivos: la 4ª pista de «Gira…» se corta la primera vez. */
  transport(): Transport {
    return {
      download: async (m: Msg, path: string, onProgress?: (r: number, t: number) => void) => {
        const { album, i } = m.raw as { album: string; i: number };
        const fail = album.startsWith("Gira") && i === 3 && !this.failed.has(`${album}:${i}`);
        writeFileSync(path, "");
        for (let k = 1; k <= 4; k++) { await this.wait(0.5); onProgress?.((3_000_000 * k) / 4, 3_000_000); }
        if (fail) { this.failed.add(`${album}:${i}`); throw new Error("conexión cortada"); }
        writeFileSync(path, Buffer.alloc(3_000_000, 120));
      },
    } as unknown as Transport;
  }
}

const U = (k: string, extra: Record<string, unknown>) => ({
  cover_medium: `/files/_covers/${k}-250.png`, cover_big: `/files/_covers/${k}-500.png`, release_date: "2017-03-10",
  record_type: "album", fans: 48211, explicit_lyrics: false, link: "https://www.deezer.com/album/1", ...extra,
});
const ALBUMS = [
  { title: "SEP7IMO DIA", ...U("sep7", { id: 77 }) },
  { title: "Gira Me Veras Volver", ...U("gira", { id: 78, release_date: "2008-07-14", explicit_lyrics: true }) },
  { title: "Lo Esencial", ...U("x", { id: 79, cover_medium: "https://e-cdns-images.dzcdn.net/images/cover//250x250-000000-80-0-0.jpg", cover_big: null, release_date: "2007-04-24", record_type: "compile" }) },
  { title: "En el Séptimo Día (Remastered)", ...U("single", { id: 80, release_date: "2017-02-09", record_type: "single" }) },
];
/** Deezer falso (el mismo que usa la prueba de Python). */
export const fakeDeezer: Getter = async (path, params) => {
  if (path === "/search/artist") {
    if (params?.q === "Nadie") throw new Error("sin red");
    return { data: [{ id: 8, name: "Soda Stereo", nb_fan: 10, picture_big: null },
                    { id: 9, name: "Soda Stereo", nb_fan: 1773909, nb_album: 22, link: "https://www.deezer.com/artist/9", picture_big: "/files/_covers/gira-250.png" }] };
  }
  if (path === "/album/77")
    return { id: 77, title: "SEP7IMO DIA", label: "Sony Music Entertainment", genres: { data: [{ name: "Rock" }, { name: "Latino" }] },
             nb_tracks: 21, duration: 4380, fans: 48211, release_date: "2017-03-10", record_type: "album",
             contributors: [{ name: "Soda Stereo" }], link: "https://www.deezer.com/album/77" };
  if (path.startsWith("/album/")) throw new Error("no encontrado");
  if (path.includes("/artist/9/albums") && !path.includes("index=")) return { data: ALBUMS.slice(0, 2), next: "https://api.deezer.com/artist/9/albums?limit=100&index=2" };
  return { data: ALBUMS.slice(2) };
};
