/** Bot falso de Telegram (lista de álbumes paginada) para probar la lógica sin red.
 *  mode "edit": el bot edita la lista en el mismo mensaje; "new": envía un mensaje por página. */
import type { Button, Msg, Transport } from "../src/types.js";

type Action = ["page", number, number] | ["album", number, string, number] | ["back", number, number] | ["noop"];

export class FakeBot implements Transport {
  msgs = new Map<number, Msg>();
  actions = new Map<string, Action>();
  nextId = 100;
  listId: number;
  constructor(public titles: string[], public mode: "edit" | "new", public nav: [string, string], public per = 10) {
    this.listId = this.newMsg().id;
    this.showPage(this.listId, 0);
  }
  private newMsg(): Msg {
    const m: Msg = { id: this.nextId++, text: "", buttons: [], out: false, viaBot: false, editDate: 0, hasDocument: false };
    this.msgs.set(m.id, m);
    return m;
  }
  private btn(msgId: number, text: string, action: Action): Button {
    const data = Buffer.from(`${msgId}:${this.actions.size}`);
    this.actions.set(data.toString(), action);
    return { text, kind: "callback", data };
  }
  showPage(mid: number, page: number) {
    const m = this.msgs.get(mid)!;
    m.editDate++;
    m.text = `Albums página ${page + 1}`;
    const chunk = this.titles.slice(page * this.per, (page + 1) * this.per);
    const pages = Math.ceil(this.titles.length / this.per);
    const rows: Button[][] = chunk.map((t) => [this.btn(mid, t, ["album", mid, t, page])]);
    const navRow: Button[] = [];
    if (page > 0) navRow.push(this.btn(mid, this.nav[0], ["page", mid, page - 1]));
    navRow.push(this.btn(mid, `${page + 1}/${pages}`, ["noop"]));
    if (page < pages - 1) navRow.push(this.btn(mid, this.nav[1], ["page", mid, page + 1]));
    rows.push(navRow, [this.btn(mid, "🔙 BACK", ["noop"])]);
    m.buttons = rows;
  }
  // ---- Transport
  async getMessages(ids: number[]) { return ids.map((i) => this.msgs.get(i)); }
  async getSince(minId: number) { return [...this.msgs.values()].filter((m) => m.id > minId).reverse(); }
  async lastId() { return this.nextId - 1; }
  async pressButton(_msgId: number, b: Button) {
    const a = this.actions.get(b.data!.toString());
    if (!a) return;
    if (a[0] === "page") {
      const target = this.mode === "edit" ? a[1] : this.newMsg().id;
      this.showPage(target, a[2]);
    } else if (a[0] === "album") {
      const [, mid, title, page] = a;
      const target = this.mode === "edit" ? mid : this.newMsg().id;
      const m = this.msgs.get(target)!;
      m.editDate++;
      m.text = `💿 ${title}\nDate: 2001-01-01\nTotal tracks: 2`;
      m.buttons = [1, 2].map((i) => [this.btn(target, `0:03:0${i} | Artista - ${title} tema ${i}`, ["noop"])]);
      m.buttons.push([this.btn(target, "GET ALL", ["noop"])], [this.btn(target, "🔙 BACK", ["back", target, page])]);
    } else if (a[0] === "back") {
      this.showPage(a[1], a[2]);
    }
  }
  async inlineQuery() { return { queryId: 1, results: [] }; }
  async sendInlineResult() {}
  async sendMessage(): Promise<Msg> { return this.newMsg(); }
  async download(): Promise<void> { throw new Error("sin archivos"); }
}
