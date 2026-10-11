/**
 * Arranca el servidor web en Node (mismas rutas e interfaz que webapp.py):
 *   npm run web                                  # http://127.0.0.1:8000
 *   npm run web -- --host 0.0.0.0 --port 8080
 * No lo abras a la vez que el servidor de Python: los dos hablarían con el bot.
 */
import { Bot } from "./bot.js";
import { cfg } from "./config.js";
import { App } from "./server.js";
import { ResilientTransport } from "./resilient.js";
import { createTrace } from "./trace.js";
import { LazyTransport, disconnect } from "./telegram.js";

// -------------------------------------------------------------- Arranque ---
async function main(argv: string[]) {
  const arg = (name: string, def: string) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
  const host = arg("--host", "127.0.0.1"), port = Number(arg("--port", "8000"));
  // Reintentos ante cortes de red y esperas de Telegram, por encima de la conexión.
  const transport = new ResilientTransport(new LazyTransport(cfg), cfg);
  const app = new App({
    transport, bot: new Bot(transport, cfg, { trace: createTrace(cfg.traceFile) }), botName: cfg.bot, downloadsDir: cfg.downloadsDir, settingsFile: cfg.settingsFile,
    webui: cfg.webui, discPause: cfg.discPause, log: (l) => console.log(`INFO:     ${l}`),
  });
  try { await app.listen(port, host); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    console.error(code === "EADDRINUSE"
      ? `El puerto ${port} ya está en uso. ¿Está abierto el servidor de Python (run_web.bat)? Ciérralo o usa --port.`
      : `No se pudo abrir el servidor: ${(e as Error).message}`);
    process.exit(1);
  }
  console.log(`deezload web (Node) -> http://${host}:${port}  (descargas en ${cfg.downloadsDir})`);
  let closing = false;
  const stop = async () => {
    if (closing) return process.exit(1);  // segundo Ctrl+C: salir ya
    closing = true;
    console.log("Cerrando…");
    setTimeout(() => process.exit(0), 3000).unref();
    await app.close();
    await disconnect();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main(process.argv.slice(2));
