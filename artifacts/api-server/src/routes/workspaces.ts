import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, dossiers, users, workspaceMembers, workspaces } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();
router.use(requireAuth);

router.get("/workspaces", async (_req, res, next) => {
  try {
    const user = res.locals.user as { id: string };
    const result = await db.select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role, createdAt: workspaces.createdAt })
      .from(workspaceMembers).innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id)).where(eq(workspaceMembers.userId, user.id));
    res.json({ workspaces: result });
  } catch (error) { next(error); }
});

router.post("/workspaces", async (req, res, next) => {
  try {
    const user = res.locals.user as { id: string; role: "admin" | "auditeur" | "client" };
    if (user.role === "client") { res.status(403).json({ error: "Un compte client ne peut pas créer de cabinet." }); return; }
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (name.length < 2 || name.length > 160) { res.status(400).json({ error: "Le nom du cabinet doit contenir entre 2 et 160 caractères." }); return; }
    const result = await db.transaction(async (tx) => {
      const [workspace] = await tx.insert(workspaces).values({ name }).returning();
      await tx.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: user.id, role: "admin" });
      return workspace;
    });
    res.status(201).json({ workspace: result });
  } catch (error) { next(error); }
});

router.post("/workspaces/:workspaceId/members", async (req, res, next) => {
  try {
    const user = res.locals.user as { id: string; role: "admin" | "auditeur" | "client" };
    const workspaceId = req.params.workspaceId;
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const requestedRole = req.body?.role === "client" ? "client" : "auditeur";
    const [actor] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, user.id))).limit(1);
    if (!actor || actor.role !== "admin") { res.status(403).json({ error: "Seul un administrateur de ce cabinet peut ajouter des membres." }); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) { res.status(400).json({ error: "Adresse e-mail invalide." }); return; }
    const [member] = await db.select({ id: users.id, email: users.email, name: users.name }).from(users).where(eq(users.email, email)).limit(1);
    if (!member) { res.status(404).json({ error: "Aucun compte ne correspond à cette adresse. L’utilisateur doit d’abord s’inscrire." }); return; }
    const [added] = await db.insert(workspaceMembers).values({ workspaceId, userId: member.id, role: requestedRole }).onConflictDoNothing().returning({ id: workspaceMembers.id, role: workspaceMembers.role });
    if (!added) { res.status(409).json({ error: "Cet utilisateur est déjà membre du cabinet." }); return; }
    res.status(201).json({ member: { ...added, email: member.email, name: member.name } });
  } catch (error) { next(error); }
});

router.get("/dossiers", async (req, res, next) => {
  try {
    const user = res.locals.user as { id: string };
    const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : "";
    const membership = await db.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.workspaceId, workspaceId))).limit(1);
    if (!membership.length) { res.status(403).json({ error: "Vous n’avez pas accès à ce cabinet." }); return; }
    const result = await db.select().from(dossiers).where(eq(dossiers.workspaceId, workspaceId)).orderBy(dossiers.createdAt);
    res.json({ dossiers: result });
  } catch (error) { next(error); }
});

router.patch("/dossiers/:dossierId/settings", async (req, res, next) => {
  try {
    const user = res.locals.user as { id: string };
    const dossierId = req.params.dossierId;
    const [existing] = await db.select({ dossierId: dossiers.id, memberRole: workspaceMembers.role }).from(dossiers).innerJoin(workspaceMembers, eq(dossiers.workspaceId, workspaceMembers.workspaceId))
      .where(and(eq(dossiers.id, dossierId), eq(workspaceMembers.userId, user.id))).limit(1);
    if (!existing) { res.status(404).json({ error: "Dossier introuvable." }); return; }
    if (existing.memberRole === "client") { res.status(403).json({ error: "Un compte client ne peut pas modifier les paramètres du dossier." }); return; }
    const value = req.body?.settings;
    if (!value || typeof value !== "object" || Array.isArray(value)) { res.status(400).json({ error: "Paramètres invalides." }); return; }
    const fiscalYear = Number(value.fiscalYear);
    const vatRates = Array.isArray(value.vatRates) ? value.vatRates.map(Number).filter((item: number) => Number.isFinite(item) && item > 0 && item < 100).slice(0, 20) : [];
    const normalizePrefixes = (items: unknown) => Array.isArray(items) ? [...new Set(items.filter((item): item is string => typeof item === "string").map((item: string) => item.replace(/\D/g, "").slice(0, 8)).filter(Boolean))].slice(0, 30) : [];
    if (!Number.isInteger(fiscalYear) || fiscalYear < 1990 || fiscalYear > 2100) { res.status(400).json({ error: "Exercice fiscal invalide." }); return; }
    const settingsJson = { fiscalYear, vatRates: [...new Set(vatRates)], vatCollectedPrefixes: normalizePrefixes(value.vatCollectedPrefixes), vatRecoverablePrefixes: normalizePrefixes(value.vatRecoverablePrefixes) };
    const [updated] = await db.update(dossiers).set({ exerciceAnnee: fiscalYear, settingsJson }).where(eq(dossiers.id, dossierId)).returning();
    res.json({ dossier: updated });
  } catch (error) { next(error); }
});

router.post("/dossiers", async (req, res, next) => {
  try {
    const user = res.locals.user as { id: string };
    const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId : "";
    const clientName = typeof req.body?.clientName === "string" ? req.body.clientName.trim() : "";
    const exerciceAnnee = Number(req.body?.exerciceAnnee);
    if (clientName.length < 2 || clientName.length > 200) { res.status(400).json({ error: "Le nom du client doit contenir entre 2 et 200 caractères." }); return; }
    if (!Number.isInteger(exerciceAnnee) || exerciceAnnee < 1990 || exerciceAnnee > 2100) { res.status(400).json({ error: "Exercice fiscal invalide." }); return; }
    const membership = await db.select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.workspaceId, workspaceId))).limit(1);
    if (!membership.length) { res.status(403).json({ error: "Vous n’avez pas accès à ce cabinet." }); return; }
    if (membership[0].role === "client") { res.status(403).json({ error: "Un compte client ne peut pas créer de dossier." }); return; }
    const [dossier] = await db.insert(dossiers).values({ workspaceId, clientName, exerciceAnnee, status: "OUVERT" }).returning();
    res.status(201).json({ dossier });
  } catch (error) { next(error); }
});

export default router;
