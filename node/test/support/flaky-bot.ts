/**
 * Bot falso con el recorrido completo (búsqueda -> ficha del artista -> lista de álbumes ->
 * ficha del álbum -> GET ALL) al que se le pueden inyectar fallos: tardar, ignorar un botón,
 * mostrar otra pantalla, saltarse una página, mandar archivos repetidos, errores de red…
 * Cada fallo se usa una vez (salvo `times`). Las respuestas llegan un poco después, como en
 * el bot real.
 */
import type { Button, Msg, Transport } from "../../src/types.js";

export type Event = "search" | "albums" | "album" | "next" | "back" | "getall";
export type Fault =
  | { on: Event; kind: "ignore"; times?: number }          // no hace nada al pulsar
  | { on: Event; kind: "delay"; ms: number }               // responde tarde
  | { on: "search"; kind: "loading"; ms: number }          // "⏳ Buscando…" y la ficha después
  | { on: "albums" | "back"; kind: "menu" }                // vuelve a mandar la ficha del artista
  | { on: "albums" | "next"; kind: "album-card" }          // muestra la ficha de un álbum
  | { on: "album"; kind: "wrong-album" }                   // abre otro álbum
  | { on: "album"; kind: "menu" }                          // muestra la ficha del artista
  | { on: "next"; kind: "double" }                         // avanza dos páginas
  | { on: "getall"; kind: "duplicate" }                    // manda cada archivo dos veces
  | { on: "getMessages" | "getSince" | "lastId" | "pressButton"; kind: "error"; error: Error; times?: number };

type Action = ["albums"] | ["getall-list"] | ["page", number] | ["album", string, number] | ["back", number] | ["menu-back"] | ["getall", string] | ["noop"];

export class FlakyBot implements Transport {
  msgs = new Map<number, Msg>();
  actions = new Map<string, [number, Action]>();
  nextId = 100;
  presses: string[] = [];
  faults: Fault[];
  latencyMs = 20;
  menuId: number | null = null;

  constructor(public sections: Record<string, string[]>, public mode: "edit" | "new",
              faults: Fault[] = [], public opts: { per?: number; counter?: boolean; deadNext?: boolean; tracks?: number; listGetAll?: boolean } = {}) {
    this.faults = faults.map((f) => ({ ...f }));
  }

  get per() { return this.opts.per ?? 4; }
  get titles() { return Object.values(this.sections).flat(); }

  /** Filas de la lista (con separadores de sección) repartidas en páginas. */
  private rows(): string[][] {
    const rows: string[][] = [];
    for (const [i, [name, list]] of Object.entries(this.sections).entries()) {
      if (i > 0) rows.push(["━━━━━", name, "━━━━━"]);
      for (const t of list) rows.push([t]);
    }
    return rows;
  }
  private get pages() { const r = this.rows(); return Array.from({ length: Math.ceil(r.length / this.per) }, (_, i) => r.slice(i * this.per, (i + 1) * this.per)); }

  private take(on: string, kinds?: string[]): Fault | undefined {
    const i = this.faults.findIndex((f) => f.on === on && (!kinds || kinds.includes(f.kind)));
    if (i < 0) return undefined;
    const f = this.faults[i] as Fault & { times?: number };
    if (f.times && f.times > 1) f.times--; else this.faults.splice(i, 1);
    return f;
  }

  private newMsg(extra: Partial<Msg> = {}): Msg {
    const m: Msg = { id: this.nextId++, text: "", buttons: [], out: false, viaBot: false, editDate: 0, hasDocument: false, ...extra };
    this.msgs.set(m.id, m);
    return m;
  }
  private btn(msgId: number, text: string, action: Action): Button {
    const data = Buffer.from(`${msgId}:${this.actions.size}`);
    this.actions.set(data.toString(), [msgId, action]);
    return { text, kind: "callback", data };
  }
  private target(from: number): Msg { return this.mode === "edit" ? this.msgs.get(from)! : this.newMsg(); }
  private later(ms: number, fn: () => void) { setTimeout(fn, ms); }

  // ---------------------------------------------------------------- Pantallas ---
  showMenu(m: Msg) {
    m.editDate++;
    m.text = "👤 Artist: Soda Stereo\n💽 Albums numbers: 22\n👥 Fans on Deezer: 1773909";
    m.buttons = [[this.btn(m.id, "🔝 TOP 30", ["noop"]), this.btn(m.id, "💽 ALBUMS", ["albums"])], [this.btn(m.id, "❌ CLOSE", ["noop"])]];
  }
  showPage(m: Msg, page: number) {
    m.editDate++;
    m.text = "👤 Artist: Soda Stereo\n💽 Albums numbers: 22";
    const pages = this.pages;
    const rows: Button[][] = [];
    // Como el bot real: la lista tiene su propio GET ALL (descargar todo). No es una ficha de álbum.
    if (this.opts.listGetAll !== false) rows.push([this.btn(m.id, "⬇️ GET ALL", ["getall-list"])]);
    rows.push(...pages[page].map((r) => r.map((t) => this.btn(m.id, t, r.length > 1 ? ["noop"] : ["album", t, page]))));
    const nav: Button[] = [];
    if (page > 0) nav.push(this.btn(m.id, "⬅️", ["page", page - 1]));
    if (this.opts.counter !== false) nav.push(this.btn(m.id, `${page + 1}/${pages.length}`, ["noop"]));
    if (page < pages.length - 1) nav.push(this.btn(m.id, "➡️", ["page", page + 1]));
    else if (this.opts.deadNext) nav.push(this.btn(m.id, "➡️", ["noop"]));
    rows.push(nav, [this.btn(m.id, "🔙 BACK", ["menu-back"])]);
    m.buttons = rows;
  }
  showAlbum(m: Msg, title: string, page: number) {
    m.editDate++;
    const n = this.opts.tracks ?? 3;
    m.text = `💽 Album: ${title}\n👤 Artist: Soda Stereo\n📅 Date: 2001-01-01\n🎧 Total tracks: ${n}`;
    m.buttons = Array.from({ length: n }, (_, i) => [this.btn(m.id, `0:03:0${i + 1} | Soda Stereo - ${title} tema ${i + 1}`, ["noop"])]);
    m.buttons.push([this.btn(m.id, "⬇️ GET ALL", ["getall", title])], [this.btn(m.id, "🔙 BACK", ["back", page])]);
  }
  private sendFiles(title: string, twice: boolean) {
    const n = this.opts.tracks ?? 3;
    for (let k = 0; k < (twice ? 2 : 1); k++)
      for (let i = 0; i < n; i++)
        this.later(this.latencyMs * (1 + i + k * n), () => this.newMsg({ hasDocument: true,
          media: { kind: "document", file_name: `Soda Stereo - ${title} tema ${i + 1}.flac`, title: `${title} tema ${i + 1}`, size: 1000 + i } }));
  }

  /** Aplica la acción de un botón (con los fallos que toquen). */
  private act(from: number, a: Action) {
    const ev: Event | null = a[0] === "albums" ? "albums" : a[0] === "page" ? "next" : a[0] === "album" ? "album"
      : a[0] === "back" || a[0] === "menu-back" ? "back" : a[0] === "getall" ? "getall" : null;
    if (a[0] === "getall-list") { this.presses.push("getall-list"); return; }
    if (!ev) return;
    this.presses.push(ev);
    const f = this.take(ev);
    if (f?.kind === "ignore") return;
    const wait = f?.kind === "delay" ? f.ms : this.latencyMs;
    this.later(wait, () => {
      const page = (p: number) => this.showPage(this.target(from), Math.max(0, Math.min(p, this.pages.length - 1)));
      if (f?.kind === "menu") return this.showMenu(this.mode === "edit" ? this.msgs.get(from)! : this.newMsg());
      if (f?.kind === "album-card") return this.showAlbum(this.target(from), this.titles[0], 0);
      switch (a[0]) {
        case "albums": return page(0);
        case "page": return page(f?.kind === "double" ? a[1] + 1 : a[1]);
        case "album": {
          const title = f?.kind === "wrong-album" ? this.titles[(this.titles.indexOf(a[1]) + 1) % this.titles.length] : a[1];
          return this.showAlbum(this.target(from), title, a[2]);
        }
        case "back": return page(a[1]);
        case "menu-back": return this.showMenu(this.target(from));
        case "getall": return this.sendFiles(a[1], f?.kind === "duplicate");
      }
    });
  }

  private fail(method: string) {
    const f = this.take(method, ["error"]);
    if (f && f.kind === "error") throw f.error;
  }

  // ---------------------------------------------------------------- Transport ---
  async getMessages(ids: number[]) { this.fail("getMessages"); return ids.map((i) => { const m = this.msgs.get(i); return m && { ...m }; }); }
  async getSince(minId: number) { this.fail("getSince"); return [...this.msgs.values()].filter((m) => m.id > minId).map((m) => ({ ...m })).reverse(); }
  async lastId() { this.fail("lastId"); return this.nextId - 1; }
  async pressButton(_msgId: number, b: Button) {
    this.fail("pressButton");
    const hit = this.actions.get(b.data!.toString());
    if (hit) this.act(hit[0], hit[1]);
  }
  async inlineQuery() { return { queryId: 1, results: [{ id: "r1", title: "Soda Stereo" }] }; }
  async sendInlineResult() {
    this.presses.push("search");
    const f = this.take("search");
    if (f?.kind === "ignore") return;
    if (f?.kind === "loading") {
      const m = this.newMsg({ out: true, viaBot: true, text: "⏳ Buscando…" });
      this.later(f.ms, () => this.showMenu(m));
      return;
    }
    this.later(f?.kind === "delay" ? f.ms : this.latencyMs, () => {
      const m = this.newMsg({ out: true, viaBot: true });
      this.menuId = m.id;
      this.showMenu(m);
    });
  }
  async sendMessage(): Promise<Msg> { return this.newMsg({ out: true }); }
  async download(): Promise<void> { throw new Error("sin archivos"); }
}
