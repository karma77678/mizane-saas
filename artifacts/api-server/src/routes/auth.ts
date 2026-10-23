import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { Router, type IRouter, type Response } from "express";
import rateLimit from "express-rate-limit";
import { and, eq, lt } from "drizzle-orm";
import { db, dossiers, sessions, users, workspaceMembers, workspaces } from "@workspace/db";
import { clearSessionCookie, cookieOptions, hashSessionToken, requireAuth, SESSION_COOKIE, SESSION_TTL_MS } from "../middlewares/auth";

const router: IRouter = Router();
// The database suite registers more accounts than the quota allows. Bypass only
// when both flags are set, so a stray variable cannot disable it in production.
const authRateLimitDisabled = process.env.NODE_ENV === "test" && process.env.AUTH_RATE_LIMIT_DISABLED === "1";
const authRateLimit = rateLimit({ windowMs: 15 * 60_000, limit: 12, standardHeaders: true, legacyHeaders: false, skip: () => authRateLimitDisabled, message: { error: "Trop de tentatives. Réessayez dans 15 minutes." } });
const scrypt = promisify(scryptCallback);

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${key.toString("hex")}`;
}
async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, salt, expectedHex] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function validEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
async function createSession(userId: string, res: Response) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ tokenHash: hashSessionToken(token), userId, expiresAt });
  res.cookie(SESSION_COOKIE, token, cookieOptions());
}

router.post("/auth/register", authRateLimit, async (req, res, next) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const workspaceName = typeof req.body?.workspaceName === "string" ? req.body.workspaceName.trim() : "";
    const clientName = typeof req.body?.clientName === "string" ? req.body.clientName.trim() : "";
    const fiscalYear = Number(req.body?.exerciceAnnee ?? new Date().getFullYear());
    if (!validEmail(email)) { res.status(400).json({ error: "Adresse e-mail invalide." }); return; }
    if (password.length < 10 || password.length > 200) { res.status(400).json({ error: "Le mot de passe doit contenir entre 10 et 200 caractères." }); return; }
    if (name.length < 2 || name.length > 120) { res.status(400).json({ error: "Le nom doit contenir entre 2 et 120 caractères." }); return; }
    if (!Number.isInteger(fiscalYear) || fiscalYear < 1990 || fiscalYear > 2100) { res.status(400).json({ error: "Exercice fiscal invalide." }); return; }
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) { res.status(409).json({ error: "Cette adresse e-mail est déjà utilisée." }); return; }
    const userRole = process.env.MIZAN_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() === email ? "admin" : "auditeur";
    const passwordHash = await hashPassword(password);
    const result = await db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({ email, name, passwordHash, role: userRole }).returning({ id: users.id, email: users.email, name: users.name, role: users.role });
      const [workspace] = await tx.insert(workspaces).values({ name: workspaceName || `Cabinet de ${name}` }).returning();
      await tx.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: user.id, role: "admin" });
      const [dossier] = await tx.insert(dossiers).values({ workspaceId: workspace.id, clientName: clientName || "Client à définir", exerciceAnnee: fiscalYear, status: "OUVERT" }).returning();
      return { user, workspace, dossier };
    });
    await createSession(result.user.id, res);
    res.status(201).json({ user: result.user, workspace: result.workspace, dossier: result.dossier });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      res.status(409).json({ error: "Cette adresse e-mail est déjà utilisée." });
      return;
    }
    next(error);
  }
});

router.post("/auth/login", authRateLimit, async (req, res, next) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!validEmail(email) || !password) { res.status(400).json({ error: "Saisissez votre adresse e-mail et votre mot de passe." }); return; }
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      res.status(401).json({ error: "Adresse e-mail ou mot de passe incorrect." });
      return;
    }
    await createSession(user.id, res);
    await db.delete(sessions).where(and(eq(sessions.userId, user.id), lt(sessions.expiresAt, new Date()))).catch(() => undefined);
    res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (error) { next(error); }
});

router.post("/auth/logout", async (req, res, next) => {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token === "string") await db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
    clearSessionCookie(res);
    res.status(204).end();
  } catch (error) { next(error); }
});

router.get("/auth/me", requireAuth, async (req, res, next) => {
  try {
    const user = res.locals.user as { id: string; email: string; name: string; role: string };
    const memberWorkspaces = await db.select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role, createdAt: workspaces.createdAt })
      .from(workspaceMembers).innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id)).where(eq(workspaceMembers.userId, user.id));
    res.json({ user, workspaces: memberWorkspaces });
  } catch (error) { next(error); }
});

export default router;
