/**
 * The hybrid audit scenario against the REAL Groq API (synthetic data only), through the real
 * routers served in-process (see ai-routes-harness.mjs). It spends a few thousand tokens of the
 * key's quota and the model's wording varies, so it checks what must hold whatever the wording:
 * known codes, real rows, the expected anomalies flagged, counters matching Groq's usage.
 *
 * OPT-IN: skipped unless MIZAN_LIVE_GROQ=1. GROQ_API_KEY comes from the environment or .env.local.
 *
 *   $env:MIZAN_LIVE_GROQ = "1"; $env:NODE_OPTIONS = "--use-system-ca"   # proxy with TLS inspection
 *   node --test artifacts/api-server/test/hybrid-audit.live.test.mjs
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { startAiRoutes } from "./ai-routes-harness.mjs";
import { makeClient } from "./helpers.mjs";
import {
  buildEntries,
  correctionRequest,
  EXPECTED_LEVEL1,
  EXPECTED_LEVEL2,
  runLevel1,
  semanticFinding,
  semanticRequests,
} from "./hybrid-scenario.mjs";

const LIVE = process.env.MIZAN_LIVE_GROQ === "1";
const ENV_FILE = new URL("../../../.env.local", import.meta.url);
if (LIVE && !process.env.GROQ_API_KEY && existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const RUNNABLE = LIVE && Boolean(process.env.GROQ_API_KEY);
/** Groq's free plan allows 8,000 tokens per minute: wait as Groq asks, a few times at most. */
const MAX_WAITS = 3;

let routes;
let call;
const post = (path, payload) => call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), ceilingMs: 150_000 });
/** Same pacing as the web app: wait on 429 as Groq asks, and give a 503 (unreadable or failed answer) one more try. */
async function postWithPause(path, payload) {
  let retriedUnavailable = false;
  for (let waits = 0; ; ) {
    const result = await post(path, payload);
    if (result.status === 503 && !retriedUnavailable) {
      retriedUnavailable = true;
      const cause = routes.logs.filter((entry) => entry.level !== "info").at(-1);
      console.log(`  503 de ${path}, nouvel essai (${cause ? JSON.stringify(cause.data).slice(0, 200) : result.json?.error})`);
      await new Promise((resume) => setTimeout(resume, 5_000));
      continue;
    }
    if (result.status !== 429 || waits >= MAX_WAITS) return result;
    waits += 1;
    await new Promise((resume) => setTimeout(resume, Math.min(90, Number(result.headers.get("retry-after")) || 60) * 1000));
  }
}

const entries = buildEntries("live");
let predictions = [];

before(async () => {
  if (!RUNNABLE) return;
  delete process.env.GROQ_BASE_URL;
  routes = await startAiRoutes();
  call = makeClient(routes.baseUrl, { ceilingMs: 150_000 });
});
after(async () => { await routes?.close(); });

const suite = RUNNABLE ? describe : describe.skip;
if (!RUNNABLE) console.log("\n[skip] Live Groq test needs MIZAN_LIVE_GROQ=1 and GROQ_API_KEY (environment or .env.local).\n");

suite("hybrid audit, live Groq", { concurrency: false, timeout: 600_000 }, () => {
  it("Level 1 is deterministic and local", () => {
    assert.deepEqual(runLevel1(entries).map((finding) => finding.ruleCode).sort(), EXPECTED_LEVEL1);
  });

  it("Level 2 flags the expected wording anomalies, on real rows, with known codes", async () => {
    for (const { body, batch } of semanticRequests(entries)) {
      const result = await postWithPause("/api/audit/semantic-review", body);
      assert.equal(result.status, 200, result.text.slice(0, 300));
      for (const item of result.json.findings) {
        assert.match(item.code, /^IA-(LIB|IMM|TVA|DED|PER|TIE|AUT)-01$/);
        assert.ok(item.rowIndices.every((index) => batch.includes(index)), "only rows that were sent");
        assert.ok(item.explanation.length > 0);
      }
      predictions.push(...result.json.findings);
    }
    const flaggedRows = new Set(predictions.flatMap((item) => item.rowIndices));
    // The computer and the restaurant bill must be caught; the exact code chosen may vary.
    for (const row of Object.keys(EXPECTED_LEVEL2).map(Number).filter((row) => row !== 1)) {
      assert.ok(flaggedRows.has(row), `row ${row + 2} (${entries[row].description}) should be flagged`);
    }
    assert.ok(predictions.some((item) => item.code === "IA-IMM-01" && item.rowIndices.includes(3)));
  });

  it("the AI correction answers on a merged Level 2 finding", async () => {
    const restaurant = predictions.find((item) => item.rowIndices.includes(0));
    const finding = semanticFinding(restaurant, entries);
    const result = await postWithPause("/api/audit/ai-correction", correctionRequest(finding, entries));
    assert.equal(result.status, 200, result.text.slice(0, 300));
    assert.ok(Array.isArray(result.json.journalEntry));
    const lines = result.json.journalEntry;
    if (lines.length) assert.equal(lines.reduce((sum, line) => sum + line.debit, 0), lines.reduce((sum, line) => sum + line.credit, 0), "a balanced entry");
  });

  it("Consommation IA matches Groq's own headers", async () => {
    const usage = (await call("/api/ai/usage")).json;
    assert.equal(usage.configured, true);
    assert.ok(usage.requests >= 2);
    assert.ok(usage.totalTokens > 0);
    assert.equal(usage.promptTokens + usage.completionTokens <= usage.totalTokens, true);
    assert.ok(usage.rateLimit?.limitRequests > 0, "x-ratelimit-limit-requests read");
    assert.ok(usage.rateLimit?.limitTokens > 0, "x-ratelimit-limit-tokens read");
    assert.equal(usage.usagePercent, Math.max(usage.tokenPercent, usage.requestPercent));
    assert.ok(["active", "limit_reached"].includes(usage.keyStatus));
    console.log(`  Groq : ${usage.requests} requête(s), ${usage.totalTokens} tokens, ${usage.rateLimit.remainingRequests}/${usage.rateLimit.limitRequests} requêtes/jour restantes`);
  });
});
