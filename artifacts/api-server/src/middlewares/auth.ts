import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { and, eq, gt } from "drizzle-orm";
import { db, sessions, users } from "@workspace/db";

export const SESSION_COOKIE = "mizan_session";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

/**
 * Shape stored on `res.locals.user`. Every route reads `user.id`, so the
 * session lookup must expose the user primary key under exactly this name:
 * an `undefined` id is not an error in Drizzle, it is serialised as `NULL`,
 * which silently turns every `WHERE user_id = $1` tenancy check into a
 * no-match and makes the whole app look empty or forbidden.
 */
export type AuthedUser = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "auditeur" | "client";
};

export function authedUser(res: Response): AuthedUser {
  const user = res.locals.user as AuthedUser | undefined;
  if (!user?.id) {
    throw new Error("requireAuth must run before a route that reads the session user.");
  }
  return user;
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function cookieOptions() {
  const separateOriginConfigured = Boolean(process.env.APP_ORIGIN?.trim());
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" || separateOriginConfigured,
    sameSite: separateOriginConfigured ? "none" as const : "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_MS,
  };
}
export function clearSessionCookie(res: Response) {
  const options = cookieOptions();
  res.clearCookie(SESSION_COOKIE, { path: options.path, sameSite: options.sameSite, secure: options.secure });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== "string" || token.length < 32) {
      res.status(401).json({ error: "Authentification requise." });
      return;
    }
    const tokenHash = hashSessionToken(token);
    const [record] = await db
      .select({ id: users.id, email: users.email, name: users.name, role: users.role })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
      .limit(1);
    if (!record?.id) {
      clearSessionCookie(res);
      res.status(401).json({ error: "Session expirée. Reconnectez-vous." });
      return;
    }
    res.locals.user = record satisfies AuthedUser;
    next();
  } catch (error) {
    next(error);
  }
}
