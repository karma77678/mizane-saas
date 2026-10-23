#!/usr/bin/env node
/**
 * Environment and reachability preflight.
 *
 * Reports what is configured and whether the PostgreSQL port is actually
 * reachable, WITHOUT printing any secret: connection strings are reduced to
 * host/port/database and passwords are never read back out.
 *
 * Run this before blaming the application for a failed import. From the
 * browser, a corporate network that silently drops the PostgreSQL port looks
 * exactly like a broken app; the TCP probe below tells the two apart:
 *
 *   - "connected"        the port is open; any remaining failure is TLS,
 *                        credentials or schema (check /api/readyz next)
 *   - "timed out"        the packets are being dropped — a firewall. Try a
 *                        phone hotspot to confirm.
 *   - "refused"          the host answered but nothing listens on that port
 *   - "DNS failure"      the hostname is wrong or unresolvable
 *
 * Dependency-free on purpose, so it works before any install step.
 *
 *   pnpm run check:env
 */
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const loaded = [];
if (typeof process.loadEnvFile === "function") {
  for (const file of [".env.local", ".env"]) {
    const path = resolve(ROOT, file);
    if (!existsSync(path)) continue;
    try {
      process.loadEnvFile(path);
      loaded.push(file);
    } catch (error) {
      console.log(`  ! ${file} could not be parsed: ${error.message}`);
    }
  }
}

let failures = 0;
const fail = (message) => { failures += 1; console.log(`  FAIL  ${message}`); };
const pass = (message) => console.log(`  ok    ${message}`);
const warn = (message) => console.log(`  warn  ${message}`);

/** Host, port and database only — never the user name or the password. */
function describeUrl(raw) {
  try {
    const url = new URL(raw);
    return {
      host: url.hostname,
      port: Number(url.port || 5432),
      database: url.pathname.replace(/^\//, "") || "(default)",
      hasPassword: Boolean(url.password),
      params: url.search ? url.search.slice(1) : "(none)",
    };
  } catch {
    return null;
  }
}

function probeTcp(host, port, timeoutMs) {
  return new Promise((resolveProbe) => {
    const startedAt = Date.now();
    const socket = connect({ host, port });
    let settled = false;
    const finish = (outcome, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe({ outcome, detail, elapsedMs: Date.now() - startedAt });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish("connected"));
    socket.once("timeout", () => finish("timed out"));
    socket.once("error", (error) => {
      const code = error.code ?? "";
      if (code === "ECONNREFUSED") finish("refused", code);
      else if (code === "ENOTFOUND" || code === "EAI_AGAIN") finish("DNS failure", code);
      else finish("error", code || error.message);
    });
  });
}

console.log("\nMizan environment check");
console.log("=======================");
console.log(`  node    ${process.version}`);
console.log(`  env     ${loaded.length ? loaded.join(", ") : "no .env file found (using the shell environment)"}`);

console.log("\nRequired");
const databaseUrl = process.env.DATABASE_URL;
let parts = null;
if (!databaseUrl) {
  fail("DATABASE_URL is not set. The API cannot start without it.");
} else {
  parts = describeUrl(databaseUrl);
  if (!parts) {
    fail("DATABASE_URL is set but is not a valid URL.");
  } else {
    pass(`DATABASE_URL -> ${parts.host}:${parts.port}/${parts.database} (params: ${parts.params})`);
    if (!parts.hasPassword) warn("DATABASE_URL carries no password. Intended only if the server trusts the host.");
    // A '#' in the value almost always means a comment was written on the same
    // line in the env file and silently became part of the connection string.
    if (databaseUrl.includes("#")) {
      fail(
        "DATABASE_URL contains '#'. An inline comment was probably glued to the value in " +
          "the env file — move the comment onto its own line.",
      );
    }
    if (/\s/.test(databaseUrl)) fail("DATABASE_URL contains whitespace; it is likely truncated or quoted.");
  }
}

console.log("\nOptional");
console.log(`  PORT                        ${process.env.PORT ?? "(unset -> 8080)"}`);
console.log(`  NODE_ENV                    ${process.env.NODE_ENV ?? "(unset -> development)"}`);
console.log(`  APP_ORIGIN                  ${process.env.APP_ORIGIN?.trim() || "(unset -> same-origin, CORS off)"}`);
console.log(`  SERVE_STATIC_DIR            ${process.env.SERVE_STATIC_DIR?.trim() || "(unset -> API only)"}`);
console.log(`  DATABASE_SSL                ${process.env.DATABASE_SSL ?? "(unset -> auto)"}`);
console.log(`  GROQ_API_KEY                ${process.env.GROQ_API_KEY ? "set (value hidden)" : "(unset -> AI features disabled)"}`);
console.log(`  MIZAN_BOOTSTRAP_ADMIN_EMAIL ${process.env.MIZAN_BOOTSTRAP_ADMIN_EMAIL ?? "(unset)"}`);

if (process.env.NODE_ENV === "production" && !process.env.APP_ORIGIN?.trim()) {
  warn("NODE_ENV=production without APP_ORIGIN: correct for same-origin deployments only.");
}

if (parts) {
  console.log("\nReachability (TCP only — no credential is sent)");
  const timeoutMs = Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? 10_000);
  const result = await probeTcp(parts.host, parts.port, timeoutMs);
  if (result.outcome === "connected") {
    pass(`TCP ${parts.host}:${parts.port} reachable in ${result.elapsedMs} ms`);
    console.log("        Port is open. If the API still fails, check TLS, credentials and schema:");
    console.log("        start the API and open /api/readyz.");
  } else {
    fail(`TCP ${parts.host}:${parts.port} ${result.outcome}${result.detail ? ` (${result.detail})` : ""} after ${result.elapsedMs} ms`);
    if (result.outcome === "timed out") {
      console.log(
        "        Packets are being dropped rather than refused, which is what a firewall\n" +
          "        blocking the PostgreSQL port looks like. This is a network problem, not an\n" +
          "        application bug: try another network (a phone hotspot) to confirm.",
      );
    }
  }
}

console.log(failures ? `\n${failures} problem(s) found.\n` : "\nEnvironment looks usable.\n");
process.exit(failures ? 1 : 0);
