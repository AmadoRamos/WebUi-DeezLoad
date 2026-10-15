/** Archivos JSON de estado (historial, «para después», artistas que sigues), junto a ajustes.json. */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

/** Lee el archivo; si no existe o está dañado, `def`. */
export function loadJson<T>(file: string, def: T): T {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return def; }
}

/** Guarda sin dejar el archivo a medias si el proceso se corta mientras escribe. */
export function saveJson(file: string, data: unknown): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 1), "utf8");
  renameSync(`${file}.tmp`, file);
}
