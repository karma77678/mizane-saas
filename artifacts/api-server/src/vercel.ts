// Vercel serverless entry point. Same Express app as index.ts, but exported as a
// request handler instead of listening on a port.
import type { IncomingMessage, ServerResponse } from "node:http";
import app from "./app";

/**
 * The routing table (scripts/vercel-build.mjs) rewrites `/api/<path>` to this
 * function with the original path in `__mizan_path`. Restore the original URL
 * so Express' `/api` router sees exactly what the browser requested.
 */
export default function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const original = url.searchParams.get("__mizan_path");
  if (original !== null) {
    url.searchParams.delete("__mizan_path");
    const query = url.searchParams.toString();
    req.url = `/api/${original}${query ? `?${query}` : ""}`;
  }
  return app(req as Parameters<typeof app>[0], res as Parameters<typeof app>[1]);
}
