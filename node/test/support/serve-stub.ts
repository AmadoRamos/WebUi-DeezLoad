/** Servidor de prueba con el doble del bot y un Deezer falso:
 *    npx tsx test/support/serve-stub.ts <puerto> <carpeta de descargas> <ajustes.json> [webui]  */
import { resolve } from "node:path";
import { Covers } from "../../src/covers.js";
import { App } from "../../src/server.js";
import { StubBot, fakeDeezer } from "./stub-bot.js";

const [port, downloads, settings, webui] = process.argv.slice(2);
const stub = new StubBot();
const app = new App({
  transport: stub.transport(), bot: stub as never, covers: new Covers(fakeDeezer), botName: "deezload2bot",
  downloadsDir: resolve(downloads), settingsFile: resolve(settings), webui: resolve(webui || "../webui"),
  discPause: Number(process.env.DISC_PAUSE ?? 5),
});
await app.listen(Number(port), "127.0.0.1");
console.log(`stub en http://127.0.0.1:${port}`);
process.on("SIGTERM", () => app.close().then(() => process.exit(0)));
