/** Configuración: lee el .env de la carpeta de arriba. */
import { config as loadEnv } from "dotenv";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NODE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BASE = resolve(NODE_DIR, "..");          // D:\musica\telegram_mcp: .env, downloads, ajustes.json y webui compartidos
loadEnv({ path: resolve(BASE, ".env"), quiet: true } as Parameters<typeof loadEnv>[0]);

const num = (name: string, def: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== "" && process.env[name] !== undefined ? v : def;
};

export const cfg = {
  apiId: Number(process.env.TG_API_ID || 0),
  apiHash: process.env.TG_API_HASH || "",
  bot: process.env.DEEZ_BOT || "deezload2bot",
  /** Sesión de Telegram: no la compartas con otro programa; usar la misma clave en dos programas a la vez
   *  puede hacer que Telegram la invalide (AUTH_KEY_DUPLICATED). */
  sessionFile: (() => {
    const f = process.env.NODE_SESSION || "deezload_node.session";
    return isAbsolute(f) ? f : resolve(NODE_DIR, f);   // en la carpeta node\
  })(),
  artistPrefix: process.env.ARTIST_PREFIX ?? ".art ",
  quietSeconds: num("QUIET_SECONDS", 3),   // silencio del bot = respuesta completa
  maxWait: num("MAX_WAIT", 30),
  maxPages: num("MAX_PAGES", 40),
  filesWait: num("FILES_WAIT", 90),        // tras GET ALL: espera máxima del primer archivo
  filesGap: num("FILES_GAP", 30),          // y sin archivos nuevos cuando faltan pistas
  pollMs: 1000,                            // cada cuánto se revisa el chat mientras se espera
  // Respaldo ante un bot lento o que responde otra cosa:
  retries: num("BOT_RETRIES", 2),          // reintentos (volver a pulsar, volver a empezar la búsqueda…)
  slowWait: num("SLOW_WAIT", 15),          // segundos esperando a que el bot reaccione antes de reintentar
  getAllRetries: num("GETALL_RETRIES", 1), // veces que se vuelve a pulsar GET ALL si no llega ningún archivo
  oneByOneMax: num("UNA_A_UNA_MAX", 10),   // álbum a medias: hasta cuántas que faltan se piden una a una (si no, GET ALL)
  floodMax: num("FLOOD_MAX_WAIT", 300),    // como mucho, segundos que se espera si Telegram lo pide
  /** Carpeta de descargas. */
  downloadsDir: (() => {
    const d = process.env.DOWNLOADS_DIR || "downloads";
    return isAbsolute(d) ? d : resolve(BASE, d);
  })(),
  settingsFile: resolve(BASE, "ajustes.json"),
  discPause: num("DISC_PAUSE", 5),         // segundos de pausa entre álbumes de una discografía
  webui: resolve(BASE, "webui"),           // la interfaz web
  /** Registro de la conversación con el bot (BOT_TRACE=0 lo desactiva). */
  traceFile: process.env.BOT_TRACE === "0" ? null : resolve(NODE_DIR, "logs", "bot.log"),
};

export type Config = typeof cfg;
