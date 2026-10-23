/**
 * End-to-end test of the hybrid audit on the built server and a real PostgreSQL database, over
 * HTTP with a real session: register → import → Level 1 constats → Level 2 by batches → accept &
 * merge / reject → reload from the database → AI correction → "Consommation IA" → logout.
 * Groq is the local fake (fake-groq.mjs, via GROQ_BASE_URL): no API cost, same answer every run.
 *
 * OPT-IN AND NON-DESTRUCTIVE, like database.test.mjs: skipped unless MIZAN_TEST_DATABASE_URL is
 * set; every row it creates carries a run tag and only those rows are deleted afterwards.
 *
 *   $env:MIZAN_TEST_DATABASE_URL = "postgresql://USER:PASSWORD@HOST:6543/postgres"
 *   pnpm --filter @workspace/api-server run build
 *   node --test artifacts/api-server/test/hybrid-audit.db.test.mjs
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { startFakeGroq } from "./fake-groq.mjs";
import { deleteTaggedRows, makeSession, startServer } from "./helpers.mjs";
import {
  buildEntries,
  constatPayload,
  correctionRequest,
  datasetPayload,
  EXPECTED_LEVEL1,
  EXPECTED_LEVEL2,
  runLevel1,
  semanticFinding,
  semanticItemFromConstat,
  semanticRequests,
  SOURCE_FILE,
} from "./hybrid-scenario.mjs";

const DATABASE_URL = process.env.MIZAN_TEST_DATABASE_URL;
const TAG = `mizan-test-hybrid-${randomUUID().slice(0, 8)}`;

let fake;
let server;
let session;
let dossierId;
let importId;
let entries;
let level1 = [];
let merged;
let rejected;

before(async () => {
  if (!DATABASE_URL) return;
  fake = await startFakeGroq();
  const started = await startServer({
    DATABASE_URL,
    DATABASE_CONNECTION_TIMEOUT_MS: process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? "15000",
    DATABASE_STATEMENT_TIMEOUT_MS: "60000",
    AUTH_RATE_LIMIT_DISABLED: "1",
    GROQ_API_KEY: "gsk_test_accepted",
    GROQ_BASE_URL: fake.baseUrl,
    GROQ_PLAN: "free",
    GROQ_DAILY_TOKEN_LIMIT: "200000",
    GROQ_DAILY_REQUEST_LIMIT: "1000",
  });
  server = started.child;
  const probe = await fetch(`${started.baseUrl}/api/readyz`, { signal: AbortSignal.timeout(90_000) });
  assert.equal(probe.status, 200, `Database not reachable, so these tests cannot run: ${await probe.text()}`);
  session = makeSession(started.baseUrl);
});

after(async () => {
  server?.kill();
  await fake?.close();
  if (DATABASE_URL) await deleteTaggedRows(DATABASE_URL, TAG);
});

const suite = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) console.log("\n[skip] Hybrid audit database test needs MIZAN_TEST_DATABASE_URL (see database.test.mjs).\n");

suite("hybrid audit, end to end on PostgreSQL", { concurrency: false }, () => {
  it("registers an auditor and imports the synthetic journal", async () => {
    const registered = await session.json("/api/auth/register", {
      email: `${TAG}@mizan-test.invalid`, password: `Test-${randomUUID()}`, name: `${TAG} auditeur`,
      workspaceName: `${TAG} cabinet`, clientName: `${TAG} client`, exerciceAnnee: 2026,
    });
    assert.equal(registered.status, 201, registered.text.slice(0, 300));
    dossierId = registered.json.dossier.id;
    entries = buildEntries(TAG);
    const imported = await session.json("/api/imports", { dossierId, fileName: SOURCE_FILE, fileDataJson: datasetPayload(entries) });
    assert.ok([200, 201].includes(imported.status), imported.text.slice(0, 300));
    importId = imported.json.import.id;
  });

  it("Tab 1 · Level 1 constats are computed locally and saved", async () => {
    level1 = runLevel1(entries);
    assert.deepEqual(level1.map((finding) => finding.ruleCode).sort(), EXPECTED_LEVEL1);
    const synced = await session.json(`/api/dossiers/${dossierId}/constats/sync`, { importId, constats: level1.map((finding) => constatPayload(finding, entries)) }, "PUT");
    assert.equal(synced.status, 200, synced.text.slice(0, 300));
    assert.equal(synced.json.constats.length, level1.length);
    assert.equal(fake.calls.length, 0, "Level 1 never calls the AI");
  });

  it("Tab 2 · Level 2 predictions come back through the authenticated route", async () => {
    const predictions = [];
    for (const { body } of semanticRequests(entries, 4)) {
      const result = await session.json("/api/audit/semantic-review", body);
      assert.equal(result.status, 200, result.text.slice(0, 300));
      predictions.push(...result.json.findings);
    }
    assert.deepEqual(Object.fromEntries(predictions.map((item) => [item.rowIndices.join(","), item.code])), EXPECTED_LEVEL2);
    const findings = predictions.map((item) => semanticFinding(item, entries));
    merged = findings.find((item) => item.ruleCode === "IA-LIB-01");
    rejected = findings.find((item) => item.ruleCode === "IA-TVA-01");
  });

  it("accept & merge and reject are saved as the web app saves them", async () => {
    for (const [finding, decision] of [[merged, "merged"], [rejected, "rejected"]]) {
      const constat = constatPayload(finding, entries, decision);
      const synced = await session.json(`/api/dossiers/${dossierId}/constats/sync`, { importId, constats: [constat] }, "PUT");
      assert.equal(synced.status, 200, synced.text.slice(0, 300));
      const patched = await session.json(`/api/constats/${encodeURIComponent(finding.id)}`, { status: constat.status }, "PATCH");
      assert.equal(patched.status, 200, patched.text.slice(0, 300));
    }
  });

  it("after a reload, the working file holds Level 1 plus the merged prediction only", async () => {
    const [imports, constats] = await Promise.all([
      session.request(`/api/imports?dossierId=${dossierId}`),
      session.request(`/api/constats?dossierId=${dossierId}`),
    ]);
    assert.equal(constats.status, 200);
    const savedEntries = imports.json.imports.find((record) => record.id === importId).fileDataJson.entries;
    const records = constats.json.constats;
    assert.equal(records.filter((record) => !record.ruleCode.startsWith("IA-")).length, level1.length);
    const semantic = records.map((record) => semanticItemFromConstat(record, savedEntries)).filter(Boolean);
    const restoredMerged = semantic.find((item) => item.finding.id === merged.id);
    const restoredRejected = semantic.find((item) => item.finding.id === rejected.id);
    assert.equal(restoredMerged?.decision, "merged");
    assert.deepEqual(restoredMerged.finding.sourceRowIds, merged.sourceRowIds);
    assert.equal(restoredMerged.finding.explanation, merged.explanation);
    assert.equal(restoredRejected?.decision, "rejected");
    assert.equal(records.find((record) => record.id === rejected.id).status, "ECARTE");
    const workingFile = [...records.filter((record) => !record.ruleCode.startsWith("IA-")), ...semantic.filter((item) => item.decision === "merged")];
    assert.equal(workingFile.length, level1.length + 1);
  });

  it("« Générer la correction IA » works on the merged finding", async () => {
    const result = await session.json("/api/audit/ai-correction", correctionRequest(merged, entries));
    assert.equal(result.status, 200, result.text.slice(0, 300));
    assert.equal(result.json.journalEntry.length, 2);
  });

  it("Consommation IA reflects the run, and is closed without a session", async () => {
    const usage = await session.request("/api/ai/usage");
    assert.equal(usage.status, 200);
    const billed = fake.calls.filter((sent) => sent.usage);
    assert.equal(usage.json.requests, billed.length);
    assert.equal(usage.json.totalTokens, billed.reduce((sum, sent) => sum + sent.usage.total_tokens, 0));
    assert.equal(usage.json.keyStatus, "active");
    assert.equal(usage.json.rateLimit.limitRequests, 1000);
    await session.json("/api/auth/logout", {});
    assert.equal((await session.request("/api/ai/usage")).status, 401);
    assert.equal((await session.json("/api/audit/semantic-review", semanticRequests(entries, 4)[0].body)).status, 401);
  });
});
