/**
 * Integration test of the hybrid audit, end to end and offline:
 *   Level 1 (deterministic engine) → Level 2 (semantic AI, by batches, with a 429 pause)
 *   → accept & merge / reject into the working file → AI correction on the merged finding
 *   → aggregated review → "Consommation IA" counters and key status.
 *
 * The real API routers run in-process (see ai-routes-harness.mjs) and talk to a local fake Groq
 * through GROQ_BASE_URL (see fake-groq.mjs): no database, no network, no API cost, same result
 * every run. The database variant is hybrid-audit.db.test.mjs, the real-Groq one
 * hybrid-audit.live.test.mjs.
 *
 *   node --test artifacts/api-server/test/hybrid-audit.test.mjs
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { INVALID_KEY, REQUESTS_PER_DAY, startFakeGroq } from "./fake-groq.mjs";
import { startAiRoutes } from "./ai-routes-harness.mjs";
import { makeClient } from "./helpers.mjs";
import {
  buildEntries,
  constatPayload,
  correctionRequest,
  EXPECTED_LEVEL1,
  EXPECTED_LEVEL2,
  reviewRequest,
  runLevel1,
  semanticFinding,
  semanticItemFromConstat,
  semanticRequests,
  SOURCE_FILE,
} from "./hybrid-scenario.mjs";

const VALID_KEY = "gsk_test_accepted";
const ENV_KEYS = ["GROQ_API_KEY", "GROQ_BASE_URL", "GROQ_MODEL", "GROQ_PLAN", "GROQ_DAILY_TOKEN_LIMIT", "GROQ_DAILY_REQUEST_LIMIT"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let fake;
let routes;
let call;
const post = (path, payload, headers = {}) => call(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: payload === undefined ? undefined : JSON.stringify(payload) });
const usage = async () => (await call("/api/ai/usage")).json;

// State carried from one step of the scenario to the next, as in the web app.
const entries = buildEntries();
let level1 = [];
let predictions = [];
let merged;
let rejected;

before(async () => {
  fake = await startFakeGroq();
  Object.assign(process.env, {
    GROQ_API_KEY: VALID_KEY, GROQ_BASE_URL: fake.baseUrl, GROQ_MODEL: "openai/gpt-oss-120b",
    GROQ_PLAN: "free", GROQ_DAILY_TOKEN_LIMIT: "200000", GROQ_DAILY_REQUEST_LIMIT: "1000",
  });
  routes = await startAiRoutes();
  call = makeClient(routes.baseUrl, { ceilingMs: 30_000 });
});

after(async () => {
  await routes?.close();
  await fake?.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("hybrid audit, offline (real routes, fake Groq)", { concurrency: false }, () => {
  it("Consommation IA starts empty, with an active key on the free plan", async () => {
    const snapshot = await usage();
    assert.equal(snapshot.configured, true);
    assert.equal(snapshot.keyStatus, "active");
    assert.equal(snapshot.plan, "free");
    assert.equal(snapshot.requests, 0);
    assert.equal(snapshot.totalTokens, 0);
    assert.equal(snapshot.usagePercent, 0);
  });

  it("checking the key spends no completion and no token", async () => {
    const result = await post("/api/ai/usage/check");
    assert.equal(result.status, 200);
    assert.equal(result.json.keyStatus, "active");
    assert.equal(result.json.requests, 0);
    assert.equal(fake.calls.length, 0);
  });

  it("Tab 1 · Level 1 finds the arithmetic anomalies locally, without calling the AI", () => {
    level1 = runLevel1(entries);
    assert.deepEqual(level1.map((finding) => finding.ruleCode).sort(), EXPECTED_LEVEL1);
    assert.ok(level1.every((finding) => !finding.origin && !finding.ruleCode.startsWith("IA-")));
    assert.equal(fake.calls.length, 0);
  });

  it("Tab 2 · Level 2 reads the wording by batches that keep each document whole", async () => {
    const requests = semanticRequests(entries, 4);
    // FAC-301 (3 rows) | FAC-303 + FAC-304 (4 rows) | FAC-305 (3 rows)
    assert.deepEqual(requests.map(({ batch }) => batch), [[0, 1, 2], [3, 4, 5, 6], [7, 8, 9]]);
    let discarded = 0;
    for (const { body } of requests) {
      const result = await post("/api/audit/semantic-review", body);
      assert.equal(result.status, 200, result.text);
      assert.equal(result.json.analysedRows, body.rows.length);
      predictions.push(...result.json.findings);
      discarded += result.json.discarded;
    }
    assert.equal(fake.calls.length, 3);
    assert.ok(fake.calls.every((sent) => sent.schema === "mizan_semantic_review"));
    // Every batch carried two hallucinations: an unknown code and a row outside the batch.
    assert.equal(discarded, 6);
    assert.deepEqual(Object.fromEntries(predictions.map((item) => [item.rowIndices.join(","), item.code])), EXPECTED_LEVEL2);
  });

  it("Level 2 sends no file or client name, and titles and amounts are the server's", () => {
    for (const sent of fake.calls) assert.ok(!JSON.stringify(sent.input).includes(SOURCE_FILE));
    const byCode = Object.fromEntries(predictions.map((item) => [item.code, item]));
    assert.equal(byCode["IA-LIB-01"].title, "Libellé incohérent avec le compte imputé");
    assert.equal(byCode["IA-LIB-01"].amount, 1000);
    assert.equal(byCode["IA-TVA-01"].amount, 100);
    assert.equal(byCode["IA-IMM-01"].amount, 14000);
  });

  it("a Groq 429 is relayed with Retry-After, then the same batch succeeds", async () => {
    const before429 = await usage();
    fake.rateLimitNext(3, 2);
    const [first] = semanticRequests(entries, 4);
    const limited = await post("/api/audit/semantic-review", first.body);
    assert.equal(limited.status, 429);
    assert.equal(limited.json.retryAfterSeconds, 2);
    assert.equal(limited.headers.get("retry-after"), "2");
    const during = await usage();
    assert.equal(during.keyStatus, "limit_reached");
    assert.ok(during.retryAfterSeconds > 0);
    assert.equal(during.failedRequests, before429.failedRequests + 1);
    const retried = await post("/api/audit/semantic-review", first.body);
    assert.equal(retried.status, 200);
    assert.equal((await usage()).keyStatus, "active");
  });

  it("rejects an empty batch, an oversized batch and a cross-site request", async () => {
    const [first] = semanticRequests(entries, 4);
    assert.equal((await post("/api/audit/semantic-review", { rows: [] })).status, 400);
    const oversized = Array.from({ length: 51 }, (_, index) => ({ ...first.body.rows[0], index }));
    assert.equal((await post("/api/audit/semantic-review", { rows: oversized })).status, 400);
    assert.equal((await post("/api/audit/semantic-review", first.body, { "sec-fetch-site": "cross-site", origin: "https://other.example" })).status, 403);
  });

  it("accept & merge puts a prediction in the working file; reject keeps it out", () => {
    const findings = predictions.map((item) => semanticFinding(item, entries));
    merged = findings.find((item) => item.ruleCode === "IA-LIB-01");
    rejected = findings.find((item) => item.ruleCode === "IA-TVA-01");
    assert.ok(merged && rejected);
    assert.equal(merged.origin, "semantic");
    assert.equal(merged.id, semanticFinding(predictions.find((item) => item.code === "IA-LIB-01"), entries).id, "IDs are stable across runs");
    assert.ok(!level1.some((finding) => finding.id === merged.id));

    // Saved as the web app saves them, then reloaded as on the next login.
    const reloaded = [constatPayload(merged, entries, "merged"), constatPayload(rejected, entries, "rejected")]
      .map((constat) => semanticItemFromConstat({ ...constat, importId: "import-1" }, entries));
    assert.equal(reloaded[0].decision, "merged");
    assert.equal(reloaded[0].finding.explanation, merged.explanation);
    assert.deepEqual(reloaded[0].finding.sourceRowIds, merged.sourceRowIds);
    assert.equal(reloaded[1].decision, "rejected");
    assert.equal(constatPayload(rejected, entries, "rejected").status, "ECARTE");

    const workingFile = [...level1, ...reloaded.filter((item) => item.decision === "merged").map((item) => item.finding)];
    assert.equal(workingFile.length, level1.length + 1);
  });

  it("« Générer la correction IA » works on the merged Level 2 finding", async () => {
    const result = await post("/api/audit/ai-correction", correctionRequest(merged, entries));
    assert.equal(result.status, 200, result.text);
    const lines = result.json.journalEntry;
    assert.equal(lines.length, 2);
    assert.equal(lines.reduce((sum, line) => sum + line.debit, 0), 1000);
    assert.equal(lines.reduce((sum, line) => sum + line.credit, 0), 1000);
    assert.deepEqual(lines.map((line) => line.accountCode), ["6132", "6111"]);
    assert.equal(fake.calls.at(-1).input.ruleCode, "IA-LIB-01");
  });

  it("the aggregated review still receives only Level 1 codes", async () => {
    const result = await post("/api/audit/ai-review", reviewRequest(entries, level1));
    assert.equal(result.status, 200, result.text);
    const sent = fake.calls.at(-1).input;
    assert.ok(sent.findings.every((item) => !item.ruleCode.startsWith("IA-")));
  });

  it("Consommation IA counts every call, tokens to the unit, and Groq's own quota", async () => {
    const snapshot = await usage();
    const billed = fake.calls.filter((sent) => sent.usage);
    const tokens = billed.reduce((sum, sent) => sum + sent.usage.total_tokens, 0);
    assert.equal(snapshot.requests, billed.length + 1, "successful calls plus the one that ended in 429");
    assert.equal(snapshot.failedRequests, 1);
    assert.equal(snapshot.totalTokens, tokens);
    assert.equal(snapshot.promptTokens + snapshot.completionTokens, tokens);
    assert.equal(snapshot.rateLimit.limitRequests, REQUESTS_PER_DAY);
    assert.equal(snapshot.requestsToday, billed.length, "taken from x-ratelimit-remaining-requests");
    assert.equal(snapshot.tokenPercent, Math.round((tokens / 200_000) * 1000) / 10);
    assert.equal(snapshot.usagePercent, Math.max(snapshot.tokenPercent, snapshot.requestPercent));
    assert.equal(snapshot.keyStatus, "active");
  });

  it("a refused key shows as invalid, and a valid check clears it", async () => {
    process.env.GROQ_API_KEY = INVALID_KEY;
    try {
      assert.equal((await post("/api/ai/usage/check")).json.keyStatus, "invalid");
      const [first] = semanticRequests(entries, 4);
      assert.equal((await post("/api/audit/semantic-review", first.body)).status, 503);
      assert.equal((await usage()).keyStatus, "invalid");
    } finally {
      process.env.GROQ_API_KEY = VALID_KEY;
    }
    assert.equal((await post("/api/ai/usage/check")).json.keyStatus, "active");
  });

  it("without a key, Level 2 is unavailable and Level 1 is unaffected", async () => {
    delete process.env.GROQ_API_KEY;
    try {
      assert.equal((await usage()).keyStatus, "not_configured");
      const [first] = semanticRequests(entries, 4);
      const result = await post("/api/audit/semantic-review", first.body);
      assert.equal(result.status, 503);
      assert.match(result.json.error, /Niveau 1/);
      assert.deepEqual(runLevel1(entries).map((finding) => finding.ruleCode).sort(), EXPECTED_LEVEL1);
    } finally {
      process.env.GROQ_API_KEY = VALID_KEY;
    }
  });

  it("Level 2 batches and usage polling are not counted by the AI correction limit (5/min)", async () => {
    // REGRESSION: that limit used to sit on its whole router, mounted on /api before these routes.
    const [first] = semanticRequests(entries, 4);
    for (let index = 0; index < 6; index += 1) {
      assert.notEqual((await call("/api/ai/usage")).status, 429);
      assert.equal((await post("/api/audit/semantic-review", first.body)).status, 200);
    }
  });

  it("logs counts only, never row content", () => {
    const batchLogs = routes.logs.filter((entry) => entry.message === "Semantic review batch");
    assert.ok(batchLogs.length >= 3);
    for (const entry of batchLogs) {
      assert.deepEqual(Object.keys(entry.data).sort(), ["discarded", "findings", "rows", "tokens"]);
      assert.ok(!JSON.stringify(entry.data).includes("Restaurant"));
    }
  });
});
