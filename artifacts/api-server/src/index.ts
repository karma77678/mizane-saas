// Must stay first: it populates process.env before any module reads it.
import { loadedEnvFiles } from "./lib/load-env";
import app from "./app";
import { logger } from "./lib/logger";
import { closePool } from "@workspace/db";

const rawPort = process.env["PORT"] ?? "8080";
const port = Number(rawPort);

if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

if (loadedEnvFiles.length) {
  logger.info({ files: loadedEnvFiles }, "Loaded environment files");
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, env: process.env.NODE_ENV ?? "development" }, "Server listening");
});

// Large accounting imports can legitimately take a while to upload; keep the
// socket deadlines above the application-level request timeout so the handler,
// not the transport, is what decides to give up (and answers with JSON).
server.requestTimeout = 0;
server.headersTimeout = 70_000;
server.keepAliveTimeout = 65_000;

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");

  const forced = setTimeout(() => {
    logger.warn("Forced exit: connections did not close in time");
    process.exit(1);
  }, 10_000);
  forced.unref();

  server.close(async () => {
    try {
      await closePool();
    } catch (error) {
      logger.error({ err: error }, "Failed to drain the database pool");
    }
    clearTimeout(forced);
    process.exit(0);
  });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown(signal));
}

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
});
