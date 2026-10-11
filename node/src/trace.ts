/**
 * Registro de la conversación con el bot (node\logs\bot.log): qué se pulsó y qué respondió el bot
 * en cada paso. Sirve para entender un fallo con el bot real. Al pasar de 2 MB, el archivo se
 * renombra a bot.old.log y se empieza uno nuevo. BOT_TRACE=0 en el .env lo desactiva.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

const MAX_BYTES = 2_000_000;

export function createTrace(file: string | null): ((line: string) => void) | undefined {
  if (!file) return undefined;
  try { mkdirSync(dirname(file), { recursive: true }); } catch { return undefined; }
  let written = 0;
  return (line: string) => {
    try {
      if (written === 0 || written > MAX_BYTES / 10) {   // de vez en cuando, mirar el tamaño
        written = 1;
        try { if (statSync(file).size > MAX_BYTES) renameSync(file, file.replace(/\.log$/, ".old.log")); } catch { /* aún no existe */ }
      }
      const text = `${new Date().toISOString()} ${line}\n`;
      appendFileSync(file, text, "utf8");
      written += text.length;
    } catch { /* el registro nunca debe romper la operación */ }
  };
}
