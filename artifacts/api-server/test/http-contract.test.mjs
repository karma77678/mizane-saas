/**
 * HTTP contract tests for the Mizan API — run against the real built server
 * (`dist/index.mjs`), with the database deliberately unreachable.
 *
 * This is the regression suite for the reported symptom: "the confirm button
 * stays stuck and the import never finishes". Every request must end in a
 * readable JSON answer within a bounded time, even when PostgreSQL is dropping
 * packets. Before the fix, `pg` waited forever (`connectionTimeoutMillis` was
 * unset) and Express had no error handler, so the browser promise never
 * settled and the spinner never stopped.
 *
 *   node --test artifacts/api-server/test/
 *
 * Needs no database and no network: the connection target is a TEST-NET-1
 * address (RFC 5737), which is guaranteed not to be routed.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeClient, startServer, UI_DIST } from "./helpers.mjs";

/** Dropped, not refused — this is what a firewalled database port looks like. */
const BLACKHOLE_DB = "postgresql://mizan:unused@192.0.2.1:5432/postgres";
const CONNECT_TIMEOUT_MS = 3_000;
/** Generous ceiling: the point is that a bound exists, not that it is tight. */
const RESPONSE_CEILING_MS = 25_000;

const SESSION_COOKIE = "mizan_session";
/** Long enough to pass the cheap length check and reach the database lookup. */
const WELL_FORMED_TOKEN = "z".repeat(43);

const OFFLINE_DB_ENV = {
  DATABASE_URL: BLACKHOLE_DB,
  DATABASE_CONNECTION_TIMEOUT_MS: String(CONNECT_TIMEOUT_MS),
  DATABASE_STATEMENT_TIMEOUT_MS: String(CONNECT_TIMEOUT_MS),
  JSON_BODY_LIMIT: "1mb",
  REQUEST_TIMEOUT_MS: "20000",
};

let server;
let call;

before(async () => {
  const started = await startServer(OFFLINE_DB_ENV);
  server = started.child;
  call = makeClient(started.baseUrl, { ceilingMs: RESPONSE_CEILING_MS });
});

after(() => {
  server?.kill();
});

describe("liveness and routing", () => {
  it("answers /api/healthz without touching the database", async () => {
    const result = await call("/api/healthz");
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { status: "ok" });
  });

  it("answers an unknown /api route with JSON, not an HTML page", async () => {
    const result = await call("/api/this-route-does-not-exist");
    // 401 for an anonymous caller: the data routers authenticate before
    // routing, which also avoids confirming which paths exist. An
    // authenticated caller reaches the JSON 404 handler. Either way the body
    // must be JSON the UI can parse — Express' HTML default would surface in
    // the app as an unexplained "server unreachable".
    assert.ok([401, 404].includes(result.status), `unexpected status ${result.status}`);
    assert.match(result.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(typeof result.json?.error, "string");
    assert.doesNotMatch(result.text, /<html/i);
  });

  it("does not advertise the server technology", async () => {
    const result = await call("/api/healthz");
    assert.equal(result.headers.get("x-powered-by"), null);
  });
});

describe("authentication is required before any data access", () => {
  for (const [name, path, init] of [
    ["GET /api/imports", "/api/imports?dossierId=2f1e3d4c-5b6a-4798-8899-aabbccddeeff", {}],
    ["GET /api/constats", "/api/constats?dossierId=2f1e3d4c-5b6a-4798-8899-aabbccddeeff", {}],
    ["GET /api/dossiers", "/api/dossiers?workspaceId=2f1e3d4c-5b6a-4798-8899-aabbccddeeff", {}],
    ["GET /api/workspaces", "/api/workspaces", {}],
    ["GET /api/auth/me", "/api/auth/me", {}],
    [
      "POST /api/imports",
      "/api/imports",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dossierId: "2f1e3d4c-5b6a-4798-8899-aabbccddeeff", fileName: "x.csv", fileDataJson: {} }),
      },
    ],
  ]) {
    it(`${name} refuses an anonymous caller with 401 JSON`, async () => {
      const result = await call(path, init);
      assert.equal(result.status, 401, `expected 401, got ${result.status}: ${result.text.slice(0, 200)}`);
      assert.equal(typeof result.json?.error, "string");
    });
  }
});

describe("an unreachable database never hangs a request", () => {
  // The core regression: each of these reaches the session lookup, so the
  // database is actually consulted. The answer must be bounded JSON.
  const cookie = `${SESSION_COOKIE}=${WELL_FORMED_TOKEN}`;

  it("/api/readyz reports the outage instead of blocking", async () => {
    const result = await call("/api/readyz");
    assert.equal(result.status, 503);
    assert.equal(result.json?.database, "unreachable");
    assert.ok(result.elapsedMs < RESPONSE_CEILING_MS, `took ${result.elapsedMs} ms`);
    assert.equal(typeof result.json?.error, "string");
  });

  it("GET /api/imports answers with a bounded JSON error", async () => {
    const result = await call("/api/imports?dossierId=2f1e3d4c-5b6a-4798-8899-aabbccddeeff", {
      headers: { cookie },
    });
    assert.ok([500, 503, 504].includes(result.status), `unexpected status ${result.status}: ${result.text.slice(0, 200)}`);
    assert.match(result.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(typeof result.json?.error, "string");
    assert.ok(result.elapsedMs < RESPONSE_CEILING_MS, `took ${result.elapsedMs} ms`);
  });

  it("POST /api/imports — the confirm-import request — always settles", async () => {
    const entries = Array.from({ length: 200 }, (_, index) => ({
      id: `row-${index}`,
      date: "2024-01-15",
      accountCode: "6111",
      accountLabel: "Achats",
      debit: index,
      credit: 0,
    }));
    const result = await call("/api/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        dossierId: "2f1e3d4c-5b6a-4798-8899-aabbccddeeff",
        fileName: "journal-test.csv",
        fileDataJson: { type: "CSV", documentType: "journal", period: "2024", entries, headers: [], sourceRows: [], mapping: {} },
      }),
    });
    assert.ok([500, 503, 504].includes(result.status), `unexpected status ${result.status}: ${result.text.slice(0, 200)}`);
    assert.equal(typeof result.json?.error, "string");
    assert.ok(result.elapsedMs < RESPONSE_CEILING_MS, `took ${result.elapsedMs} ms`);
  });
});

describe("request validation produces usable errors", () => {
  it("rejects a body over the parser limit with 413 JSON", async () => {
    const result = await call("/api/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${WELL_FORMED_TOKEN}` },
      // JSON_BODY_LIMIT is 1mb for this server.
      body: JSON.stringify({ filler: "x".repeat(2 * 1024 * 1024) }),
    });
    assert.equal(result.status, 413);
    assert.match(result.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(typeof result.json?.error, "string");
  });

  it("rejects malformed JSON with 400 JSON rather than an HTML stack page", async () => {
    const result = await call("/api/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${WELL_FORMED_TOKEN}` },
      body: "{ this is not json",
    });
    assert.equal(result.status, 400);
    assert.equal(typeof result.json?.error, "string");
    assert.doesNotMatch(result.text, /<html/i);
  });

  it("refuses a cross-site mutation", async () => {
    const result = await call("/api/imports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "sec-fetch-site": "cross-site",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ dossierId: "2f1e3d4c-5b6a-4798-8899-aabbccddeeff" }),
    });
    assert.equal(result.status, 403);
    assert.equal(typeof result.json?.error, "string");
  });

  it("never leaks a stack trace to the client", async () => {
    const result = await call("/api/imports?dossierId=2f1e3d4c-5b6a-4798-8899-aabbccddeeff", {
      headers: { cookie: `${SESSION_COOKIE}=${WELL_FORMED_TOKEN}` },
    });
    assert.doesNotMatch(result.text, /at \w+ \(/);
    assert.doesNotMatch(result.text, /node_modules/);
    assert.doesNotMatch(result.text, /192\.0\.2\.1/);
  });
});

describe("single-process deployment (SERVE_STATIC_DIR)", () => {
  let staticServer;
  let staticBase;

  before(async () => {
    if (!existsSync(resolve(UI_DIST, "index.html"))) return;
    const started = await startServer({ ...OFFLINE_DB_ENV, SERVE_STATIC_DIR: UI_DIST });
    staticServer = started.child;
    staticBase = started.baseUrl;
  });

  after(() => {
    staticServer?.kill();
  });

  it("serves the built UI and falls back to index.html for SPA routes", async (t) => {
    if (!staticBase) {
      t.skip("UI not built (run pnpm run build)");
      return;
    }
    const root = await fetch(`${staticBase}/`, { signal: AbortSignal.timeout(RESPONSE_CEILING_MS) });
    assert.equal(root.status, 200);
    assert.match(await root.text(), /<div id="root">|<script/);

    const deepLink = await fetch(`${staticBase}/import`, { signal: AbortSignal.timeout(RESPONSE_CEILING_MS) });
    assert.equal(deepLink.status, 200, "a client-side route must return the SPA shell, not 404");

    // The API must still win over the SPA fallback.
    const api = await fetch(`${staticBase}/api/healthz`, { signal: AbortSignal.timeout(RESPONSE_CEILING_MS) });
    assert.equal(api.status, 200);
    assert.deepEqual(await api.json(), { status: "ok" });
  });
});
