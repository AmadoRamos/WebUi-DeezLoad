/**
 * «Para después»: álbumes y canciones apuntados para descargarlos más tarde (a mano, o solos a
 * la hora que digas en Ajustes). Se guardan en deseos.json.
 */
import { randomUUID } from "node:crypto";
import * as songs from "./songs.js";
import { loadJson, saveJson } from "./store.js";

export interface Wish {
  id: string;
  tipo: "album" | "cancion";
  artista: string;
  titulo: string;          // el del álbum o el de la canción
  album?: string;          // canción: su álbum, si se sabe (para elegir esa versión)
  nombre?: string;         // álbum: el nombre del artista que dio el bot (búsqueda directa)
  lista?: boolean;         // álbum: el título viene de la lista del bot (🅴 si es explícito)
  anadido: number;
}

const key = (w: Pick<Wish, "tipo" | "artista" | "titulo">) => `${w.tipo}|${songs.artistKey(w.artista)}|${songs.titleKey(w.titulo)}`;

export class Wishlist {
  items: Wish[];
  constructor(private file: string, private notify: () => void = () => {}) {
    this.items = loadJson<Wish[]>(file, []);
  }

  /** Lo apunta (si ya estaba, devuelve el que había). */
  add(w: Omit<Wish, "id" | "anadido">): Wish {
    const had = this.items.find((x) => key(x) === key(w));
    if (had) return had;
    const item: Wish = { ...w, id: randomUUID().replace(/-/g, "").slice(0, 10), anadido: Date.now() / 1000 };
    this.items.push(item);
    this.save();
    return item;
  }

  /** Quita y devuelve los de esos ids (todos, si no se dan). */
  take(ids?: string[]): Wish[] {
    const out = ids ? this.items.filter((x) => ids.includes(x.id)) : [...this.items];
    if (!out.length) return out;
    this.items = this.items.filter((x) => !out.includes(x));
    this.save();
    return out;
  }

  private save() {
    saveJson(this.file, this.items);
    this.notify();
  }
}
