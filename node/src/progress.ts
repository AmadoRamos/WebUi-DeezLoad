/**
 * Avisos de progreso (con AsyncLocalStorage): la interfaz web registra una función
 * para saber en qué paso va cada operación con el bot. En la CLI nadie escucha y no hace nada.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const progress = new AsyncLocalStorage<(step: string) => void>();

export function withProgress<T>(onStep: (step: string) => void, fn: () => Promise<T>): Promise<T> {
  return progress.run(onStep, fn);
}

export function report(step: string): void {
  const cb = progress.getStore();
  if (cb) {
    try { cb(step); } catch { /* un aviso nunca debe romper la operación */ }
  }
}
