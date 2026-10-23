import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name} value: "${raw}". Expected a positive number.`);
  }
  return Math.trunc(value);
}

/** Structured accounting imports are large; keep the parser and the route limit aligned. */
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT?.trim() || "50mb";
const REQUEST_TIMEOUT_MS = envInt("REQUEST_TIMEOUT_MS", 120_000);

/**
 * `trust proxy` makes Express read the client IP from X-Forwarded-For. That is
 * required behind a load balancer (Railway, ALB, nginx) and harmful without
 * one: any caller could then set the header freely and, since the login and AI
 * rate limiters key on `req.ip`, get a fresh quota on every request.
 *
 * Default: trust one hop in production (where a proxy is the norm), trust
 * nothing otherwise. Override with TRUST_PROXY — a hop count, or `false`.
 */
const trustProxySetting = process.env.TRUST_PROXY?.trim();
const trustProxy = trustProxySetting
  ? (trustProxySetting === "false" ? false : Number.isFinite(Number(trustProxySetting)) ? Number(trustProxySetting) : trustProxySetting)
  : process.env.NODE_ENV === "production" ? 1 : false;
app.set("trust proxy", trustProxy);
app.disable("x-powered-by");

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

/**
 * Last-resort deadline. Even with bounded database timeouts, a request must
 * never be able to hang a browser tab forever: answer with a readable 504
 * instead of leaving the client's promise pending.
 */
const requestTimeout: RequestHandler = (req, res, next) => {
  const timer = setTimeout(() => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    req.log?.warn({ url: req.originalUrl }, "Request exceeded its deadline");
    res.status(504).json({
      error:
        "Le serveur n’a pas répondu dans le délai imparti. Vérifiez la connexion à la base de données puis réessayez.",
    });
  }, REQUEST_TIMEOUT_MS);
  timer.unref?.();
  res.on("close", () => clearTimeout(timer));
  res.on("finish", () => clearTimeout(timer));
  next();
};
app.use(requestTimeout);

const allowedAppOrigin = process.env.APP_ORIGIN?.trim().replace(/\/$/, "");
app.use(cors({
  // Same-origin deployments do not need CORS. Configure APP_ORIGIN only when the UI is hosted separately.
  origin: allowedAppOrigin || false,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
}));
app.use((req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) { next(); return; }
  const origin = req.get("origin");
  const fetchSite = req.get("sec-fetch-site");
  if (allowedAppOrigin && origin && origin !== allowedAppOrigin) {
    res.status(403).json({ error: "Origine non autorisée pour cette opération." });
    return;
  }
  if (fetchSite === "cross-site" && (!allowedAppOrigin || origin !== allowedAppOrigin)) {
    res.status(403).json({ error: "Requête intersite refusée." });
    return;
  }
  next();
});
app.use(cookieParser());
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use("/api", router);

// An unknown /api path must stay machine-readable: the UI parses JSON error
// bodies, and Express' HTML default would surface as an unexplained failure.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Route d’API inconnue." });
});

/**
 * Optional single-process deployment (Railway, AWS, any container): point
 * SERVE_STATIC_DIR at the built UI and the API also serves it, with SPA
 * fallback. Left unset, the API stays API-only and the UI is hosted separately.
 */
const staticDirSetting = process.env.SERVE_STATIC_DIR?.trim();
if (staticDirSetting) {
  const staticDir = resolve(process.cwd(), staticDirSetting);
  if (!existsSync(staticDir)) {
    throw new Error(`SERVE_STATIC_DIR points at a missing directory: ${staticDir}`);
  }
  const indexHtml = resolve(staticDir, "index.html");
  app.use(express.static(staticDir, { index: false, maxAge: "1h" }));
  app.get("*splat", (_req, res, next) => {
    if (!existsSync(indexHtml)) { next(); return; }
    res.sendFile(indexHtml);
  });
  logger.info({ staticDir }, "Serving the built UI from the API process");
}

/**
 * Terminal error handler. Without it Express answers with an HTML stack page,
 * which the UI cannot parse and reports as a generic unreachable-server error.
 * Internal details stay in the logs; the client gets a usable message.
 */
const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const status =
    typeof error === "object" && error !== null && "status" in error && Number((error as { status: unknown }).status) >= 400
      ? Number((error as { status: number }).status)
      : typeof error === "object" && error !== null && "statusCode" in error && Number((error as { statusCode: unknown }).statusCode) >= 400
        ? Number((error as { statusCode: number }).statusCode)
        : 500;
  const type = typeof error === "object" && error !== null && "type" in error ? String((error as { type: unknown }).type) : "";

  req.log?.error(
    { err: error instanceof Error ? { message: error.message, stack: error.stack } : error, url: req.originalUrl },
    "Unhandled request error",
  );

  if (res.headersSent) {
    res.destroy();
    return;
  }

  if (type === "entity.too.large" || status === 413) {
    res.status(413).json({
      error: `La requête dépasse la taille autorisée (${JSON_BODY_LIMIT}). Importez le fichier par période ou par feuille.`,
    });
    return;
  }
  if (type === "entity.parse.failed" || status === 400) {
    res.status(400).json({ error: "Requête invalide : le corps JSON n’a pas pu être lu." });
    return;
  }

  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: "Une erreur interne est survenue. L’opération n’a pas été enregistrée.",
  });
};
app.use(errorHandler);

export default app;
