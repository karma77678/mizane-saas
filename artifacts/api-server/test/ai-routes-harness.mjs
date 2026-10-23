/**
 * Serves the real AI routers (Level 2 semantic review, AI correction, aggregated review, AI usage)
 * from the test process, with no database: they are bundled with esbuild from `src/` and only
 * `requireAuth` is replaced by a pass-through. The session check itself is covered by the
 * database suites; everything after it here is the shipped code.
 *
 * Set GROQ_API_KEY / GROQ_BASE_URL / GROQ_PLAN... in process.env BEFORE calling this: the
 * model name and the usage limits are read when the bundle is imported.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { API_DIR } from "./helpers.mjs";

const ENTRY = `
import express from "express";
import semanticRouter from "./routes/audit-semantic";
import correctionRouter from "./routes/audit-ai-correction";
import reviewRouter from "./routes/audit-ai";
import usageRouter from "./routes/ai-usage";

export function createApp(logs) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    const log = (level) => (data, message) => logs.push({ level, message: message ?? data, data });
    req.log = { info: log("info"), warn: log("warn"), error: log("error") };
    next();
  });
  // Same order as src/routes/index.ts: a router-level middleware leaks onto the routers mounted after it.
  app.use("/api", reviewRouter, correctionRouter, semanticRouter, usageRouter);
  return app;
}
`;

export async function startAiRoutes() {
  const outdir = await mkdtemp(join(tmpdir(), "mizan-ai-routes-"));
  const outfile = join(outdir, "ai-routes.mjs");
  await build({
    stdin: { contents: ENTRY, resolveDir: resolve(API_DIR, "src"), sourcefile: "ai-routes-entry.ts", loader: "ts" },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "error",
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    plugins: [{
      name: "pass-through-auth",
      setup(builder) {
        builder.onResolve({ filter: /middlewares\/auth$/ }, () => ({ path: "auth", namespace: "test-auth" }));
        builder.onLoad({ filter: /.*/, namespace: "test-auth" }, () => ({ contents: "export const requireAuth = (_req, _res, next) => next();", loader: "js" }));
      },
    }],
  });
  const { createApp } = await import(pathToFileURL(outfile).href);
  const logs = [];
  const server = createApp(logs).listen(0, "127.0.0.1");
  await new Promise((ready) => server.once("listening", ready));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    logs,
    async close() {
      await new Promise((done) => server.close(done));
      await rm(outdir, { recursive: true, force: true });
    },
  };
}
