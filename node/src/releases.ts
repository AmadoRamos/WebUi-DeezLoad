/**
 * Artistas que sigues y sus lanzamientos nuevos. Al seguir a un artista se apuntan todos sus
 * lanzamientos en Deezer; cada cierto tiempo (y con «Buscar ahora») se vuelve a mirar y lo que
 * no estaba es nuevo. Se guarda en seguidos.json.
 */
import type { Covers } from "./covers.js";
import { norm } from "./covers.js";
import { loadJson, saveJson } from "./store.js";

export interface Followed { id: number; nombre: string; foto: string | null; conocidos: number[]; desde: number }
export interface Release {
  id: number; artista: string; artista_id: number; album: string;
  fecha: string | null; tipo: string | null; mediana: string | null; explicito: boolean; visto: number;
}
interface Saved { artistas: Followed[]; novedades: Release[]; revisado: number }

export class Releases {
  data: Saved;
  constructor(private file: string, private notify: () => void = () => {}) {
    const d = loadJson<Partial<Saved>>(file, {});
    this.data = { artistas: d.artistas ?? [], novedades: d.novedades ?? [], revisado: d.revisado ?? 0 };
  }

  /** Sigue al artista de Deezer con ese nombre (el de fans más parecido, si se sabe). */
  async follow(covers: Covers, name: string, fans?: number | null): Promise<Followed> {
    const artist = await covers.findArtist(name, fans);
    if (!artist?.id) throw new Error(`Deezer no tiene a «${name}».`);
    const had = this.data.artistas.find((a) => a.id === artist.id);
    if (had) return had;
    const known = (await covers.albumsOf(artist.id)).map((a) => a.id).filter((id): id is number => typeof id === "number");
    const f: Followed = { id: artist.id, nombre: artist.nombre ?? name, foto: artist.foto, conocidos: known, desde: Date.now() / 1000 };
    this.data.artistas.push(f);
    this.save();
    return f;
  }

  unfollow(id: number) {
    this.data.artistas = this.data.artistas.filter((a) => a.id !== id);
    this.data.novedades = this.data.novedades.filter((r) => r.artista_id !== id);
    this.save();
  }

  /** Mira si los artistas que sigues tienen lanzamientos nuevos; los devuelve (y quedan en novedades).
   *  Un artista que Deezer no devuelve ahora (sin red…) se mira la próxima vez. */
  async check(covers: Covers): Promise<Release[]> {
    const found: Release[] = [];
    for (const a of this.data.artistas) {
      let albums;
      try { albums = await covers.albumsOf(a.id); } catch { continue; }
      for (const al of albums) {
        if (typeof al.id !== "number" || a.conocidos.includes(al.id)) continue;
        a.conocidos.push(al.id);
        found.push({ id: al.id, artista: a.nombre, artista_id: a.id, album: al.titulo, fecha: al.fecha, tipo: al.tipo,
                     mediana: al.mediana, explicito: al.explicito, visto: Date.now() / 1000 });
      }
    }
    this.data.novedades.push(...found);
    this.data.revisado = Date.now() / 1000;
    this.save();
    return found;
  }

  /** Quita y devuelve las novedades con esos ids. */
  take(ids: number[]): Release[] {
    const out = this.data.novedades.filter((r) => ids.includes(r.id));
    this.data.novedades = this.data.novedades.filter((r) => !ids.includes(r.id));
    if (out.length) this.save();
    return out;
  }

  private save() {
    saveJson(this.file, this.data);
    this.notify();
  }
}

/** Si salieron a la vez la versión explícita y la limpia de un disco (mismo título), solo la que
 *  prefieres ("cualquiera": la primera). */
export function onePerTitle(releases: Release[], version: "cualquiera" | "explicita" | "limpia"): Release[] {
  const groups = new Map<string, Release[]>();
  for (const r of releases) {
    const k = `${r.artista_id}|${norm(r.album)}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()].map((g) =>
    (version === "cualquiera" ? undefined : g.find((r) => r.explicito === (version === "explicita"))) ?? g[0]);
}
