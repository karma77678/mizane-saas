import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db } from "@workspace/db";

const router: IRouter = Router();

/** Liveness: the process answers. Deliberately does not touch the database. */
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

/**
 * Readiness: the database is actually reachable. Use this for platform health
 * checks, and locally to tell a blocked PostgreSQL port (a firewall dropping
 * 5432/6543) apart from an application bug — the pool's connection timeout
 * bounds the wait, so this always answers.
 */
router.get("/readyz", async (_req, res) => {
  const startedAt = Date.now();
  try {
    await db.execute(sql`select 1`);
    res.json({ status: "ok", database: "reachable", latencyMs: Date.now() - startedAt });
  } catch (error) {
    res.status(503).json({
      status: "unavailable",
      database: "unreachable",
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Unknown database error",
      // Drizzle's "Failed query" hides the driver error (timeout, TLS, auth).
      cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
    });
  }
});

export default router;
