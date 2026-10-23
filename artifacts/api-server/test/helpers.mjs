/** Shared harness for the API test suites: boot the built server, call it over HTTP. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ENTRY = resolve(API_DIR, "dist", "index.mjs");
export const UI_DIST = resolve(API_DIR, "..", "audit-maroc", "dist", "public");

export function assertBuilt() {
  if (!existsSync(ENTRY)) {
    throw new Error(`Build the API first (pnpm run build). Missing: ${ENTRY}`);
  }
}

/** Asks the OS for a free port, then releases it for the child to bind. */
export function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

/**
 * Boots the built server and waits until /api/healthz answers. Readiness is
 * polled rather than parsed out of the logs, so the log format (pretty in
 * development, JSON in production) cannot break a suite.
 */
export async function startServer(env = {}) {
  assertBuilt();
  const port = await freePort();
  const child = spawn(process.execPath, [ENTRY], {
    cwd: API_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      LOG_LEVEL: "error",
      PORT: String(port),
      APP_ORIGIN: "",
      SERVE_STATIC_DIR: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });

  let exited = false;
  child.once("exit", () => { exited = true; });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Server exited before listening:\n${output}`);
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/api/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (probe.ok) {
        return { child, port, baseUrl: `http://127.0.0.1:${port}`, output: () => output };
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((wait) => setTimeout(wait, 150));
  }
  child.kill();
  throw new Error(`Server did not become ready in time:\n${output}`);
}

/**
 * HTTP client with its own deadline, so a hanging request fails a test instead
 * of stalling the run. Returns status, headers, raw text and parsed JSON.
 */
export function makeClient(baseUrl, { ceilingMs = 30_000 } = {}) {
  return async function call(path, init = {}) {
    const startedAt = Date.now();
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(init.ceilingMs ?? ceilingMs),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, headers: response.headers, text, json, elapsedMs: Date.now() - startedAt };
  };
}

/**
 * A caller with its own cookie jar — one jar per simulated user, which is what
 * makes cross-tenant isolation testable.
 */
export function makeSession(baseUrl, options) {
  const call = makeClient(baseUrl, options);
  const jar = new Map();

  const store = (headers) => {
    for (const raw of headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (!value) jar.delete(name);
      else jar.set(name, value);
    }
  };

  const cookieHeader = () =>
    [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");

  return {
    get cookies() { return cookieHeader(); },
    clearCookies() { jar.clear(); },
    async request(path, init = {}) {
      const headers = { ...(init.headers ?? {}) };
      const cookie = cookieHeader();
      if (cookie) headers.cookie = cookie;
      const result = await call(path, { ...init, headers });
      store(result.headers);
      return result;
    },
    async json(path, payload, method = "POST") {
      return this.request(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
  };
}

/**
 * Deletes exactly the rows a database suite created, found by their tag. `users` cascades to
 * sessions and memberships; workspaces cascade to dossiers -> imports -> constats. Plain `pg`,
 * because `@workspace/db` exports TypeScript source.
 */
export async function deleteTaggedRows(databaseUrl, tag) {
  const { createRequire } = await import("node:module");
  const { existsSync: exists, readFileSync } = await import("node:fs");
  const { rootCertificates } = await import("node:tls");
  const require = createRequire(new URL("../../../lib/db/package.json", import.meta.url));
  const { Client } = require("pg");
  const caPath = new URL("../../../prod-ca-2021.crt", import.meta.url);
  const url = new URL(databaseUrl);
  for (const key of ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) url.searchParams.delete(key);
  const client = new Client({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true, ...(exists(caPath) ? { ca: [...rootCertificates, readFileSync(caPath, "utf8")] } : {}) },
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? 15_000),
  });
  try {
    await client.connect();
    await client.query("delete from workspaces where name like $1", [`${tag}%`]);
    await client.query("delete from users where email like $1", [`${tag}%`]);
  } finally {
    await client.end().catch(() => {});
  }
}
