import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rootCertificates } from "node:tls";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name} value: "${raw}". Expected a positive number of milliseconds.`);
  }
  return Math.trunc(value);
}

/**
 * Without these bounds a single unreachable PostgreSQL host (a firewall that
 * drops 5432/6543, a paused Supabase project, a dropped VPN) leaves
 * `pool.connect()` pending forever: the Express handler never answers and the
 * browser spinner never stops. Every wait in the data path is bounded here.
 */
const CONNECTION_TIMEOUT_MS = positiveInt("DATABASE_CONNECTION_TIMEOUT_MS", 10_000);
const STATEMENT_TIMEOUT_MS = positiveInt("DATABASE_STATEMENT_TIMEOUT_MS", 60_000);
const IDLE_TIMEOUT_MS = positiveInt("DATABASE_IDLE_TIMEOUT_MS", 30_000);
const POOL_MAX = positiveInt("DATABASE_POOL_MAX", 8);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal", "postgres", "db"]);

/**
 * TLS is never weakened here: verification stays on in every mode. Managed
 * providers whose certificate chain is not in the public trust store (for
 * example a direct `db.<ref>.supabase.co` connection) are supported by adding
 * their CA bundle *alongside* the system roots, not by turning checks off.
 */
function resolveSsl(): pg.PoolConfig["ssl"] {
  const mode = (process.env.DATABASE_SSL ?? "auto").trim().toLowerCase();
  const host = hostOf(connectionString!);
  const urlSaysDisable = /[?&]sslmode=disable\b/i.test(connectionString!);

  if (mode === "disable" || (mode === "auto" && (urlSaysDisable || LOCAL_HOSTS.has(host)))) {
    return undefined;
  }

  const caPathCandidates = [
    process.env.DATABASE_CA_CERT_PATH,
    process.env.PGSSLROOTCERT,
    resolve(process.cwd(), "prod-ca-2021.crt"),
    resolve(process.cwd(), "..", "..", "prod-ca-2021.crt"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const caPath = caPathCandidates.find((candidate) => existsSync(candidate));
  const extraCa = caPath ? readFileSync(caPath, "utf8") : null;

  return {
    rejectUnauthorized: true,
    ...(extraCa ? { ca: [...rootCertificates, extraCa] } : {}),
  };
}

/**
 * pg lets `sslmode`/`sslrootcert` in the URL replace the `ssl` object below
 * wholesale, which silently drops the extra CA and fails with "self-signed
 * certificate in certificate chain" on Supabase. resolveSsl() has already read
 * them, so strip them and let it be the single source of TLS settings.
 */
function withoutSslParams(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) {
      parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export const pool: pg.Pool = new Pool({
  connectionString: withoutSslParams(connectionString),
  ssl: resolveSsl(),
  max: POOL_MAX,
  connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  idleTimeoutMillis: IDLE_TIMEOUT_MS,
  // Server-side cap: releases the backend even if the client goes away.
  statement_timeout: STATEMENT_TIMEOUT_MS,
  // Client-side cap: rejects the promise if the server stops answering.
  query_timeout: STATEMENT_TIMEOUT_MS,
  keepAlive: true,
  application_name: process.env.DATABASE_APPLICATION_NAME ?? "mizan-api",
});

// An error on an *idle* client is emitted on the pool. Unhandled, it takes the
// whole API process down (and with it every in-flight audit import).
pool.on("error", (error) => {
  console.error("[db] idle client error:", error instanceof Error ? error.message : error);
});

export const db = drizzle(pool, { schema });

/** Drain the pool on shutdown so deploys and restarts do not strand backends. */
export async function closePool(): Promise<void> {
  await pool.end();
}

export * from "./schema";
