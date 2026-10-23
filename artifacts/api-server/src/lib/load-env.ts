import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Loads `.env.local` then `.env` from the nearest ancestor directory that has
 * one, before any module that reads `process.env` is evaluated.
 *
 * Uses Node's built-in `process.loadEnvFile` (Node >= 20.12), so there is no
 * extra dependency, and it never overrides a variable that is already set:
 * values injected by the shell, by Docker, by Railway or by a task definition
 * always win over a checked-out file. Import this module *first* in the entry
 * point — ES module side effects run in import order.
 */
const FILES = [".env.local", ".env"] as const;
const MAX_PARENTS = 5;

function candidateDirs(): string[] {
  const dirs: string[] = [];
  let current = process.cwd();
  for (let depth = 0; depth <= MAX_PARENTS; depth += 1) {
    dirs.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

export function loadEnvFiles(): string[] {
  const loaded: string[] = [];
  if (typeof process.loadEnvFile !== "function") return loaded;

  for (const dir of candidateDirs()) {
    const present = FILES.map((file) => resolve(dir, file)).filter((path) => existsSync(path));
    if (!present.length) continue;
    for (const path of present) {
      try {
        process.loadEnvFile(path);
        loaded.push(path);
      } catch (error) {
        // A malformed env file must not stop a server whose variables may
        // already come from the real environment.
        console.warn(`[env] ignored ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Only the nearest directory that carries env files is used.
    break;
  }
  return loaded;
}

export const loadedEnvFiles: string[] = loadEnvFiles();
