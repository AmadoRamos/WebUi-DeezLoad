/**
 * Línea de comandos:
 *   npm run cli -- login                               1ª vez: inicia sesión (teléfono + código)
 *   npm run cli -- albums "Soda Stereo" [n] [--raw]    álbumes por sección (n = artista elegido)
 *   npm run cli -- tracks "Soda Stereo" "Signos" [n]   canciones de un álbum
 *   npm run cli -- discography "Soda Stereo" [n]       todos los álbumes con sus canciones
 *   npm run cli -- album "Soda Stereo" "Signos" [n]    prueba: abre un álbum y muestra la respuesta
 *   npm run cli -- send "texto"                        prueba: envía texto y muestra la respuesta
 *   npm run cli -- click <msg_id> "texto"              prueba: pulsa un botón
 *   npm run cli -- pages <msg_id>                      prueba: recorre todas las páginas
 *   npm run cli -- inline "<consulta>"                 prueba: consulta inline
 *   npm run cli -- pick "<consulta>" [n]               prueba: elige el resultado inline n
 *   npm run cli -- getall "Soda Stereo" "Signos" [n]   pulsa GET ALL y lista los archivos (no descarga)
 *   npm run cli -- download "Soda Stereo" "Signos" [n] descarga el álbum a la carpeta de descargas
 *                  (las canciones que ya tienes se saltan; a la vez: lo que diga ajustes.json)
 * Los avisos de progreso salen por la consola de errores; el resultado (JSON) por la salida normal.
 */
import { Bot, withProgress } from "./bot.js";
import { cfg } from "./config.js";
import { DownloadJob, Downloader } from "./downloads.js";
import { ResilientTransport } from "./resilient.js";
import { createTrace } from "./trace.js";
import type { Transport } from "./types.js";
import { connect, disconnect, login } from "./telegram.js";

const USAGE = `Uso: npm run cli -- <login|albums|tracks|discography|album|send|click|pages|inline|pick|getall|download> [argumentos]`;

async function main(args: string[]) {
  const [cmd, ...rest] = args;
  if (!cmd) { console.log(USAGE); return; }
  if (cmd === "login") { console.log(JSON.stringify(await login(cfg), null, 2)); return; }
  const n = (s?: string) => (s && /^\d+$/.test(s) ? Number(s) : 0);
  const transport = new ResilientTransport((await connect(cfg)).transport, cfg);
  const bot = new Bot(transport, cfg, { trace: createTrace(cfg.traceFile) });
  const run = async () => {
    switch (cmd) {
      case "albums": return bot.albums(rest[0], n(rest.find((a) => /^\d+$/.test(a))), rest.includes("--raw"));
      case "tracks": return bot.albumTracks(rest[0], rest[1], n(rest[2]));
      case "discography": return bot.discography(rest[0], n(rest[1]));
      case "album": return bot.albumView(rest[0], rest[1], n(rest[2]));
      case "send": return bot.send(rest.join(" "));
      case "click": return bot.click(Number(rest[0]), rest.slice(1).join(" "));
      case "pages": return bot.allPages(Number(rest[0]));
      case "inline": return bot.inline(rest.join(" "));
      case "pick": return bot.inlinePick(rest[0], n(rest[1]));
      case "getall": {
        const [card, error] = await bot.albumCardId(rest[0], rest[1], n(rest[2]));
        if (card === null) return error;
        const docs = await bot.collectGetAll(card);
        return { album_message_id: card, total_pistas: docs.length, pistas: docs.map((m) => ({ message_id: m.id, ...m.media })) };
      }
      case "download": return download(bot, transport, rest[0], rest[1], n(rest[2]));
      default: return { error: `Comando desconocido: ${cmd}`, uso: USAGE };
    }
  };
  // Los pasos se muestran en la consola de errores para no ensuciar el JSON
  const out = await withProgress((step) => process.stderr.write(`… ${step}\n`), run);
  console.log(JSON.stringify(out, null, 2));
}

const LABEL = { pending: "pendiente", downloading: "bajando ", done: "lista    ", exists: "ya estaba", error: "ERROR    " } as const;

/** Descarga un álbum mostrando el avance de cada pista por la consola de errores. */
async function download(bot: Bot, transport: Transport,
                        artist: string, album: string, index: number) {
  if (!artist || !album) return { error: 'Uso: npm run cli -- download "Artista" "Álbum" [n]' };
  const job = new DownloadJob(artist, album, index);
  const shown = new Map<number, string>();
  let step: string | null = null, last = 0;
  const say = (line: string) => process.stderr.write(`${line}\n`);
  const dl = new Downloader(transport, bot, cfg.downloadsDir, cfg.settingsFile, () => {
    if (job.step && job.step !== step) say(`… ${(step = job.step)}`);
    job.tracks.forEach((t, i) => {
      if (t.status === "pending" || shown.get(i) === t.status) return;
      shown.set(i, t.status);
      say(`  [${String(i + 1).padStart(2)}/${job.tracks.length}] ${LABEL[t.status]} ${t.file ?? t.file_name ?? t.title}${t.error ? `: ${t.error}` : ""}`);
    });
    const d = job.toDict();
    if (d.received && Date.now() - last > 2000 && d.done < d.total) {
      last = Date.now();
      say(`  … ${Math.round((100 * d.received) / d.size)}% (${d.done}/${d.total} pistas)`);
    }
  });
  say(`Carpeta: ${cfg.downloadsDir} · ${dl.settings.descargas_simultaneas} a la vez`);
  await dl.runJob(job);
  const d = job.toDict();
  if (d.status === "error") process.exitCode = 1;
  return {
    estado: d.status, error: d.error, total: d.total, listas: d.done, ya_estaban: d.existing, carpeta: cfg.downloadsDir,
    pistas: job.tracks.map((t) => ({ titulo: t.title, estado: t.status, archivo: t.file, ...(t.error ? { error: t.error } : {}) })),
  };
}

main(process.argv.slice(2))
  .catch((e) => { console.error(`Error: ${e?.message || e}`); process.exitCode = 1; })
  .finally(() => disconnect().then(() => process.exit()));
