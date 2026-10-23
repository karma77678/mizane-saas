#!/usr/bin/env node
/**
 * Builds Mizan for Vercel as ONE project behind ONE URL, using the Build Output
 * API (https://vercel.com/docs/build-output-api/v3):
 *
 *   .vercel/output/static/                 -> the built React UI
 *   .vercel/output/functions/api/index.func -> the Express API (bundled)
 *   .vercel/output/config.json             -> /api/* to the function, SPA fallback
 *
 * Same origin for UI and API: no CORS, no APP_ORIGIN, session cookie stays Lax.
 */
import { execSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = join(ROOT, "artifacts", "api-server");
const UI_DIST = join(ROOT, "artifacts", "audit-maroc", "dist", "public");
const OUT = join(ROOT, ".vercel", "output");
const FUNC = join(OUT, "functions", "api", "index.func");

function run(command) {
  console.log(`\n> ${command}`);
  execSync(command, { cwd: ROOT, stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } });
}

await rm(OUT, { recursive: true, force: true });

// 1. UI (Vite). Its prebuild step also writes the source archive.
run("pnpm --filter @workspace/audit-maroc run build");

// 2. API, bundled from the Vercel entry with esbuild (resolved from api-server).
const requireFromApi = createRequire(join(API_DIR, "package.json"));
const { build } = await import(pathToFileURL(requireFromApi.resolve("esbuild")).href);
await mkdir(FUNC, { recursive: true });
await build({
  entryPoints: [join(API_DIR, "src", "vercel.ts")],
  platform: "node",
  target: "node22",
  bundle: true,
  format: "esm",
  outfile: join(FUNC, "index.mjs"),
  logLevel: "info",
  external: ["pg-native", "pino-pretty", "*.node"],
  banner: {
    js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';
globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);`,
  },
});
await writeFile(join(FUNC, "package.json"), JSON.stringify({ type: "module" }));
await writeFile(
  join(FUNC, ".vc-config.json"),
  JSON.stringify({
    runtime: "nodejs22.x",
    handler: "index.mjs",
    launcherType: "Nodejs",
    shouldAddHelpers: false,
    maxDuration: 60,
  }, null, 2),
);
// lib/db looks for this CA bundle in the working directory.
const ca = join(ROOT, "prod-ca-2021.crt");
if (existsSync(ca)) await cp(ca, join(FUNC, "prod-ca-2021.crt"));

// 3. Static UI.
await cp(UI_DIST, join(OUT, "static"), { recursive: true });

// 4. Routing.
await writeFile(
  join(OUT, "config.json"),
  JSON.stringify({
    version: 3,
    routes: [
      { src: "^/api/(.*)$", dest: "/api/index?__mizan_path=$1" },
      { handle: "filesystem" },
      { src: "^/(.*)$", dest: "/index.html" },
    ],
  }, null, 2),
);

console.log(`\nVercel output ready in ${OUT}`);
