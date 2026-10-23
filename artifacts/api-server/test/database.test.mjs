/**
 * End-to-end tests against a real PostgreSQL database: authentication, the
 * full import flow, persistence across sessions, cabinet isolation and role
 * enforcement. Everything goes over HTTP against the built server, so what is
 * tested is what actually ships.
 *
 * OPT-IN AND NON-DESTRUCTIVE BY DESIGN
 * ------------------------------------
 * The suite skips unless MIZAN_TEST_DATABASE_URL is set — deliberately a
 * different variable from DATABASE_URL, so it can never run against a
 * production database by accident. It creates nothing but its own rows, every
 * one tagged with a unique run id, and deletes exactly those rows afterwards.
 * It never drops, truncates or alters a table, and never touches a row it did
 * not create.
 *
 * Run it (PowerShell):
 *   $env:MIZAN_TEST_DATABASE_URL = "postgresql://USER:PASSWORD@HOST:6543/postgres"
 *   node --test artifacts/api-server/test/database.test.mjs
 *
 * Run it (bash):
 *   MIZAN_TEST_DATABASE_URL="postgresql://..." node --test artifacts/api-server/test/database.test.mjs
 *
 * The schema must already exist (lib/db/migrations/0001_mizan_saas.sql).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { rootCertificates } from "node:tls";
import { after, before, describe, it } from "node:test";
import { makeSession, startServer } from "./helpers.mjs";

const DATABASE_URL = process.env.MIZAN_TEST_DATABASE_URL;
const RUN_ID = randomUUID().slice(0, 8);
/** Every row this suite creates carries this marker, for exact cleanup. */
const TAG = `mizan-test-${RUN_ID}`;
const PASSWORD = `Test-${randomUUID()}`;

let server;
let baseUrl;
const createdEmails = [];

/** A fresh registered user: own cabinet, own first dossier. */
async function register(label) {
  const session = makeSession(baseUrl);
  const email = `${TAG}-${label}@mizan-test.invalid`;
  createdEmails.push(email);
  const result = await session.json("/api/auth/register", {
    email,
    password: PASSWORD,
    name: `${TAG} ${label}`,
    workspaceName: `${TAG} cabinet ${label}`,
    clientName: `${TAG} client ${label}`,
    exerciceAnnee: 2024,
  });
  assert.equal(result.status, 201, `register ${label} failed: ${result.text.slice(0, 300)}`);
  return { session, email, ...result.json };
}

const sampleDataset = (rows = 3) => ({
  type: "CSV",
  documentType: "journal",
  period: "2024",
  importedAt: new Date().toISOString(),
  headers: ["Date", "Compte", "Libellé", "Débit", "Crédit"],
  mapping: { date: "0", journal: "", accountCode: "1", accountLabel: "2", reference: "", description: "", debit: "3", credit: "4" },
  sourceRows: Array.from({ length: rows }, (_, i) => ["15/01/2024", "6111", "Achats", String(100 + i), "0"]),
  entries: Array.from({ length: rows }, (_, i) => ({
    id: `${TAG}-entry-${i}`,
    date: "15/01/2024",
    journal: "",
    accountCode: "6111",
    accountLabel: "Achats",
    reference: "",
    description: "",
    debit: 100 + i,
    credit: 0,
    sourceFile: "journal.csv",
    sourceRow: i + 2,
  })),
});

const constat = (id, overrides = {}) => ({
  id,
  ruleCode: "ECR-01",
  severity: "high",
  amount: 1234.56,
  explanation: "Constat de test — explication initiale.",
  cellReference: "Ligne 2, colonne Débit",
  status: "A_EXAMINER",
  proposedCorrection: null,
  ...overrides,
});

before(async () => {
  if (!DATABASE_URL) return;
  const started = await startServer({
    DATABASE_URL,
    // Overridable for slow links (mobile hotspot): a TLS handshake to the
    // Supabase pooler can take well over 15 s there.
    DATABASE_CONNECTION_TIMEOUT_MS: process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? "15000",
    DATABASE_STATEMENT_TIMEOUT_MS: "60000",
    AUTH_RATE_LIMIT_DISABLED: "1",
  });
  server = started.child;
  baseUrl = started.baseUrl;

  // Fail loudly and early if the database is unreachable, rather than letting
  // every test fail with a confusing error.
  const probe = await fetch(`${baseUrl}/api/readyz`, { signal: AbortSignal.timeout(90_000) });
  const body = await probe.json();
  assert.equal(
    probe.status,
    200,
    `Database not reachable, so these tests cannot run: ${JSON.stringify(body)}`,
  );
});

after(async () => {
  // Delete only what this run created. `users` cascades to sessions and
  // workspace_members; workspaces cascade to dossiers -> imports -> constats.
  // Plain `pg` rather than `@workspace/db`: that package exports TypeScript
  // source, which Node cannot import here. Kill the server first so a failed
  // cleanup can never leave it running and hang the suite.
  server?.kill();
  if (DATABASE_URL && createdEmails.length) {
    const require = createRequire(new URL("../../../lib/db/package.json", import.meta.url));
    const { Client } = require("pg");
    const caPath = new URL("../../../prod-ca-2021.crt", import.meta.url);
    const url = new URL(DATABASE_URL);
    for (const key of ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) url.searchParams.delete(key);
    const client = new Client({
      connectionString: url.toString(),
      ssl: { rejectUnauthorized: true, ...(existsSync(caPath) ? { ca: [...rootCertificates, readFileSync(caPath, "utf8")] } : {}) },
      connectionTimeoutMillis: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? 15_000),
    });
    try {
      await client.connect();
      await client.query("delete from workspaces where name like $1", [`${TAG}%`]);
      await client.query("delete from users where email like $1", [`${TAG}%`]);
    } finally {
      await client.end().catch(() => {});
    }
  }
});

const suite = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  console.log(
    "\n[skip] Database tests need MIZAN_TEST_DATABASE_URL. " +
      "See the header of artifacts/api-server/test/database.test.mjs.\n",
  );
}

suite("authentication and session", () => {
  it("registers, then /auth/me returns the user id and the cabinet", async () => {
    // REGRESSION TEST. The session middleware used to expose the primary key
    // as `userId`, while every route read `user.id`. An undefined id is not an
    // error in Drizzle — it is sent as NULL — so `where user_id = NULL`
    // matched nothing and this endpoint silently returned zero cabinets. The
    // UI then had no dossier, and importing was impossible.
    const alice = await register("auth-a");
    const me = await alice.session.request("/api/auth/me");
    assert.equal(me.status, 200);
    assert.ok(me.json.user?.id, "the session user must carry an `id`");
    assert.equal(me.json.user.email, alice.email);
    assert.equal(me.json.workspaces.length, 1, "the registered cabinet must be visible");
    assert.match(me.json.workspaces[0].name, new RegExp(TAG));
    assert.equal(me.json.workspaces[0].role, "admin");
  });

  it("logs in again on a fresh session and still sees the data (persistence)", async () => {
    const alice = await register("auth-b");
    const fresh = makeSession(baseUrl);
    const login = await fresh.json("/api/auth/login", { email: alice.email, password: PASSWORD });
    assert.equal(login.status, 200);
    assert.equal(login.json.user.id, alice.user.id);

    const dossiers = await fresh.request(
      `/api/dossiers?workspaceId=${encodeURIComponent(alice.workspace.id)}`,
    );
    assert.equal(dossiers.status, 200);
    assert.equal(dossiers.json.dossiers.length, 1);
  });

  it("rejects a wrong password and invalidates the cookie on logout", async () => {
    const alice = await register("auth-c");
    const bad = await makeSession(baseUrl).json("/api/auth/login", {
      email: alice.email,
      password: "not-the-password",
    });
    assert.equal(bad.status, 401);

    const out = await alice.session.request("/api/auth/logout", { method: "POST" });
    assert.equal(out.status, 204);
    const after = await alice.session.request("/api/auth/me");
    assert.equal(after.status, 401, "the session must be dead after logout");
  });
});

suite("import flow", () => {
  it("persists an import and returns it on reload", async () => {
    const alice = await register("import-a");
    const dataset = sampleDataset(5);

    const created = await alice.session.json("/api/imports", {
      dossierId: alice.dossier.id,
      fileName: "journal-2024.csv",
      fileDataJson: dataset,
    });
    assert.equal(created.status, 201, created.text.slice(0, 300));
    assert.ok(created.json.import?.id, "the API must return the new import id");
    assert.ok(created.json.import?.createdAt);
    // The response must stay small: the browser already holds the file data.
    assert.deepEqual(Object.keys(created.json.import).sort(), ["createdAt", "id"]);

    const listed = await alice.session.request(
      `/api/imports?dossierId=${encodeURIComponent(alice.dossier.id)}`,
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.json.imports.length, 1);
    const stored = listed.json.imports[0];
    assert.equal(stored.id, created.json.import.id);
    assert.equal(stored.fileName, "journal-2024.csv");
    // Round-trip of the structured payload: this is what the UI rehydrates.
    assert.equal(stored.fileDataJson.entries.length, 5);
    assert.equal(stored.fileDataJson.entries[0].accountCode, "6111");
    assert.equal(stored.fileDataJson.sourceRows.length, 5);
    assert.deepEqual(stored.fileDataJson.headers, dataset.headers);
  });

  it("survives a new login — the data is in PostgreSQL, not in the tab", async () => {
    const alice = await register("import-b");
    await alice.session.json("/api/imports", {
      dossierId: alice.dossier.id,
      fileName: "persistent.csv",
      fileDataJson: sampleDataset(2),
    });

    const fresh = makeSession(baseUrl);
    await fresh.json("/api/auth/login", { email: alice.email, password: PASSWORD });
    const listed = await fresh.request(
      `/api/imports?dossierId=${encodeURIComponent(alice.dossier.id)}`,
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.json.imports.length, 1);
    assert.equal(listed.json.imports[0].fileName, "persistent.csv");
  });

  it("rejects invalid metadata and a malformed dossier id without a 500", async () => {
    const alice = await register("import-c");

    const noName = await alice.session.json("/api/imports", {
      dossierId: alice.dossier.id,
      fileName: "",
      fileDataJson: sampleDataset(1),
    });
    assert.equal(noName.status, 400);
    assert.equal(typeof noName.json.error, "string");

    const badPayload = await alice.session.json("/api/imports", {
      dossierId: alice.dossier.id,
      fileName: "x.csv",
      fileDataJson: "not-an-object",
    });
    assert.equal(badPayload.status, 400);

    // A non-UUID would raise `invalid input syntax for type uuid` in
    // PostgreSQL and surface as an opaque 500.
    const badId = await alice.session.json("/api/imports", {
      dossierId: "not-a-uuid",
      fileName: "x.csv",
      fileDataJson: sampleDataset(1),
    });
    assert.equal(badId.status, 403);
    assert.equal(typeof badId.json.error, "string");
  });

  it("deletes the dossier's imports on request", async () => {
    const alice = await register("import-d");
    await alice.session.json("/api/imports", {
      dossierId: alice.dossier.id,
      fileName: "temp.csv",
      fileDataJson: sampleDataset(1),
    });
    const removed = await alice.session.request(
      `/api/dossiers/${encodeURIComponent(alice.dossier.id)}/imports`,
      { method: "DELETE" },
    );
    assert.equal(removed.status, 204);
    const listed = await alice.session.request(
      `/api/imports?dossierId=${encodeURIComponent(alice.dossier.id)}`,
    );
    assert.equal(listed.json.imports.length, 0);
  });
});

suite("constats synchronisation", () => {
  it("upserts in bulk across chunk boundaries", async () => {
    const alice = await register("constat-a");
    const created = await alice.session.json("/api/imports", {
      dossierId: alice.dossier.id,
      fileName: "bulk.csv",
      fileDataJson: sampleDataset(1),
    });
    const importId = created.json.import.id;

    // 600 rows exercises the 400-row chunking, and used to mean 600
    // sequential UPDATE round trips.
    const many = Array.from({ length: 600 }, (_, i) => constat(`${TAG}-bulk-${i}`));
    const synced = await alice.session.json(
      `/api/dossiers/${encodeURIComponent(alice.dossier.id)}/constats/sync`,
      { importId, constats: many },
      "PUT",
    );
    assert.equal(synced.status, 200, synced.text.slice(0, 300));
    assert.equal(synced.json.constats.length, 600);

    const listed = await alice.session.request(
      `/api/constats?dossierId=${encodeURIComponent(alice.dossier.id)}`,
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.json.constats.length, 600);
  });

  it("re-syncing refreshes the text but never resets the auditor's decision", async () => {
    const alice = await register("constat-b");
    const created = await alice.session.json("/api/imports", {
      dossierId: alice.dossier.id,
      fileName: "decision.csv",
      fileDataJson: sampleDataset(1),
    });
    const importId = created.json.import.id;
    const id = `${TAG}-decision-1`;

    await alice.session.json(
      `/api/dossiers/${encodeURIComponent(alice.dossier.id)}/constats/sync`,
      { importId, constats: [constat(id)] },
      "PUT",
    );

    const reviewed = await alice.session.json(`/api/constats/${encodeURIComponent(id)}`, { status: "VERIFIE" }, "PATCH");
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.json.constat.status, "VERIFIE");

    // A later background sync must not undo that.
    await alice.session.json(
      `/api/dossiers/${encodeURIComponent(alice.dossier.id)}/constats/sync`,
      { importId, constats: [constat(id, { explanation: "Explication mise à jour.", status: "A_EXAMINER" })] },
      "PUT",
    );

    const listed = await alice.session.request(
      `/api/constats?dossierId=${encodeURIComponent(alice.dossier.id)}`,
    );
    const row = listed.json.constats.find((item) => item.id === id);
    assert.equal(row.status, "VERIFIE", "the human decision must survive a re-sync");
    assert.equal(row.explanation, "Explication mise à jour.", "the description must be refreshed");
  });

  it("refuses a sync whose import belongs to another dossier", async () => {
    const alice = await register("constat-c");
    const second = await alice.session.json("/api/dossiers", {
      workspaceId: alice.workspace.id,
      clientName: `${TAG} second client`,
      exerciceAnnee: 2024,
    });
    assert.equal(second.status, 201);

    const created = await alice.session.json("/api/imports", {
      dossierId: alice.dossier.id,
      fileName: "mismatch.csv",
      fileDataJson: sampleDataset(1),
    });

    const mismatched = await alice.session.json(
      `/api/dossiers/${encodeURIComponent(second.json.dossier.id)}/constats/sync`,
      { importId: created.json.import.id, constats: [constat(`${TAG}-mismatch-1`)] },
      "PUT",
    );
    assert.equal(mismatched.status, 400);
  });
});

suite("cabinet isolation", () => {
  it("a member of another cabinet cannot read or write a foreign dossier", async () => {
    const alice = await register("iso-a");
    const bob = await register("iso-b");

    const created = await alice.session.json("/api/imports", {
      dossierId: alice.dossier.id,
      fileName: "private.csv",
      fileDataJson: sampleDataset(2),
    });
    const importId = created.json.import.id;
    const id = `${TAG}-iso-1`;
    await alice.session.json(
      `/api/dossiers/${encodeURIComponent(alice.dossier.id)}/constats/sync`,
      { importId, constats: [constat(id)] },
      "PUT",
    );

    // Bob is authenticated, but in a different cabinet.
    for (const [label, result] of [
      ["list imports", await bob.session.request(`/api/imports?dossierId=${encodeURIComponent(alice.dossier.id)}`)],
      ["list constats", await bob.session.request(`/api/constats?dossierId=${encodeURIComponent(alice.dossier.id)}`)],
      ["list dossiers", await bob.session.request(`/api/dossiers?workspaceId=${encodeURIComponent(alice.workspace.id)}`)],
      [
        "create import",
        await bob.session.json("/api/imports", {
          dossierId: alice.dossier.id,
          fileName: "intrusion.csv",
          fileDataJson: sampleDataset(1),
        }),
      ],
      [
        "sync constats",
        await bob.session.json(
          `/api/dossiers/${encodeURIComponent(alice.dossier.id)}/constats/sync`,
          { importId, constats: [constat(`${TAG}-iso-intrusion`)] },
          "PUT",
        ),
      ],
      [
        "delete imports",
        await bob.session.request(`/api/dossiers/${encodeURIComponent(alice.dossier.id)}/imports`, { method: "DELETE" }),
      ],
      [
        "create a dossier in the cabinet",
        await bob.session.json("/api/dossiers", {
          workspaceId: alice.workspace.id,
          clientName: `${TAG} intrusion`,
          exerciceAnnee: 2024,
        }),
      ],
    ]) {
      assert.ok([403, 404].includes(result.status), `${label}: expected a refusal, got ${result.status}`);
    }

    // A known constat id must not be reachable either.
    const patched = await bob.session.json(`/api/constats/${encodeURIComponent(id)}`, { status: "ECARTE" }, "PATCH");
    assert.equal(patched.status, 404, "a foreign constat must not be addressable by id");

    // And Alice's data is untouched.
    const check = await alice.session.request(`/api/constats?dossierId=${encodeURIComponent(alice.dossier.id)}`);
    assert.equal(check.json.constats.length, 1);
    assert.equal(check.json.constats[0].status, "A_EXAMINER");
  });

  it("a cabinet member with the client role is read-only", async () => {
    const alice = await register("role-a");
    const claire = await register("role-b");

    const added = await alice.session.json(
      `/api/workspaces/${encodeURIComponent(alice.workspace.id)}/members`,
      { email: claire.email, role: "client" },
    );
    assert.equal(added.status, 201, added.text.slice(0, 300));

    // Reading is allowed.
    const dossiers = await claire.session.request(
      `/api/dossiers?workspaceId=${encodeURIComponent(alice.workspace.id)}`,
    );
    assert.equal(dossiers.status, 200);
    assert.ok(dossiers.json.dossiers.length >= 1);
    const listed = await claire.session.request(
      `/api/imports?dossierId=${encodeURIComponent(alice.dossier.id)}`,
    );
    assert.equal(listed.status, 200);

    // Writing is not.
    const write = await claire.session.json("/api/imports", {
      dossierId: alice.dossier.id,
      fileName: "client-write.csv",
      fileDataJson: sampleDataset(1),
    });
    assert.equal(write.status, 403);
    assert.match(write.json.error, /[Ll]ecture seule/);

    const removal = await claire.session.request(
      `/api/dossiers/${encodeURIComponent(alice.dossier.id)}/imports`,
      { method: "DELETE" },
    );
    assert.equal(removal.status, 403);

    const settings = await claire.session.json(
      `/api/dossiers/${encodeURIComponent(alice.dossier.id)}/settings`,
      { settings: { fiscalYear: 2023, vatRates: [20] } },
      "PATCH",
    );
    assert.equal(settings.status, 403);
  });

  it("stores dossier settings for the owning cabinet only", async () => {
    const alice = await register("settings-a");
    const saved = await alice.session.json(
      `/api/dossiers/${encodeURIComponent(alice.dossier.id)}/settings`,
      { settings: { fiscalYear: 2023, vatRates: [20, 14], vatCollectedPrefixes: ["4455"], vatRecoverablePrefixes: ["3455"] } },
      "PATCH",
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.json.dossier.exerciceAnnee, 2023);
    assert.deepEqual(saved.json.dossier.settingsJson.vatRates, [20, 14]);

    const reloaded = await alice.session.request(
      `/api/dossiers?workspaceId=${encodeURIComponent(alice.workspace.id)}`,
    );
    const dossier = reloaded.json.dossiers.find((item) => item.id === alice.dossier.id);
    assert.equal(dossier.exerciceAnnee, 2023);
    assert.deepEqual(dossier.settingsJson.vatCollectedPrefixes, ["4455"]);
  });
});
