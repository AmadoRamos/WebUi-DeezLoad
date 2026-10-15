/** Espera de pistas tras GET ALL con un bot que tarda y hace pausas. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { Bot } from "../src/bot.js";
import { cfg } from "../src/config.js";
import type { Button, Msg, Transport } from "../src/types.js";

class SlowBot implements Transport {
  pressed: number | null = null;
  card: Msg;
  constructor(total: number | null, private schedule: number[]) {
    this.card = { id: 10, text: total ? `💽 Album: X\n🎧 Total tracks: ${total}` : "💽 Album: X", buttons: [[{ text: "GET ALL", kind: "callback", data: Buffer.from("g") }]],
                  out: false, viaBot: false, editDate: 0, hasDocument: false };
  }
  private arrived(): Msg[] {
    if (this.pressed === null) return [];
    const el = (Date.now() - this.pressed) / 1000;
    return this.schedule.flatMap((t, i) => (t <= el ? [{ id: 100 + i, text: "", buttons: [], out: false, viaBot: false, editDate: 0, hasDocument: true }] : []));
  }
  async getMessages(ids: number[]) { return ids.map(() => this.card); }
  async getSince(minId: number) { return this.arrived().filter((m) => m.id > minId).reverse(); }
  async lastId() { return 50; }
  async pressButton(_: number, _b: Button) { this.pressed = Date.now(); }
  async inlineQuery() { return { queryId: 1, results: [] }; }
  async sendInlineResult() {}
  async sendMessage(): Promise<Msg> { return this.card; }
  async download(): Promise<void> { throw new Error("sin archivos"); }
}

const fast = { ...cfg, quietSeconds: 0.4, maxWait: 3, pollMs: 100, filesWait: 5, filesGap: 1.5 };
const cases: [string, number | null, number[], number][] = [
  ["el bot tarda 2 s en empezar (12 pistas)", 12, Array.from({ length: 12 }, (_, i) => 2 + 0.1 * i), 12],
  ["pausas de 1 s entre archivos (5 pistas)", 5, [0.2, 1.2, 2.2, 3.2, 4.2], 5],
  ["faltan pistas: la ficha dice 5, llegan 3", 5, [0.2, 0.4, 0.6], 3],
  ["el bot no manda nada", 5, [], 0],
  ["ficha sin total: llegan 4 juntas", null, [0.2, 0.3, 0.4, 0.5], 4],
];
for (const [name, total, sched, want] of cases) {
  it(name, async () => {
    const docs = await new Bot(new SlowBot(total, sched), fast).collectGetAll(10);
    assert.equal(docs.length, want);
  });
}
