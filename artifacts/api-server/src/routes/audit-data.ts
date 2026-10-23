import { Router, type IRouter } from "express";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  constats,
  dossiers,
  imports,
  workspaceMembers,
} from "@workspace/db";
import { authedUser, requireAuth } from "../middlewares/auth";

const router: IRouter = Router();
router.use(requireAuth);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Identifiers reach PostgreSQL as `uuid`; a malformed one raises
 * `invalid input syntax for type uuid` and surfaces as an opaque 500.
 * Reject it up front so the UI gets a 403/400 it can display.
 */
function asUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

/**
 * Membership lookup for a dossier, in a single round trip: returns the
 * caller's role in the owning cabinet, or `null` when the dossier does not
 * exist or belongs to a cabinet the caller is not a member of. Access and
 * role were two separate queries before, doubling latency on every write.
 */
async function dossierMembership(userId: string, dossierId: string) {
  const [record] = await db
    .select({ workspaceId: dossiers.workspaceId, role: workspaceMembers.role })
    .from(dossiers)
    .innerJoin(
      workspaceMembers,
      eq(dossiers.workspaceId, workspaceMembers.workspaceId),
    )
    .where(
      and(
        eq(dossiers.id, dossierId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .limit(1);

  return record ?? null;
}

/** Same contract as `dossierMembership`, reached through an import. */
async function importMembership(userId: string, importId: string) {
  const [record] = await db
    .select({ dossierId: imports.dossierId, role: workspaceMembers.role })
    .from(imports)
    .innerJoin(dossiers, eq(imports.dossierId, dossiers.id))
    .innerJoin(
      workspaceMembers,
      eq(dossiers.workspaceId, workspaceMembers.workspaceId),
    )
    .where(
      and(
        eq(imports.id, importId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .limit(1);

  return record ?? null;
}

router.delete(
  "/dossiers/:dossierId/imports",
  async (req, res, next) => {
    try {
      const user = authedUser(res);
      const dossierId = asUuid(req.params.dossierId);

      if (!dossierId) {
        res.status(403).json({ error: "Dossier inaccessible." });
        return;
      }

      const membership = await dossierMembership(user.id, dossierId);

      if (!membership) {
        res.status(403).json({ error: "Dossier inaccessible." });
        return;
      }

      if (membership.role === "client") {
        res.status(403).json({
          error:
            "Lecture seule : seul un auditeur ou administrateur peut supprimer les imports.",
        });
        return;
      }

      await db.delete(imports).where(eq(imports.dossierId, dossierId));
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  },
);

router.get("/imports", async (req, res, next) => {
  try {
    const user = authedUser(res);
    const dossierId = asUuid(req.query.dossierId);

    if (!dossierId || !(await dossierMembership(user.id, dossierId))) {
      res.status(403).json({ error: "Dossier inaccessible." });
      return;
    }

    const records = await db
      .select()
      .from(imports)
      .where(eq(imports.dossierId, dossierId))
      .orderBy(asc(imports.createdAt));

    res.json({ imports: records });
  } catch (error) {
    next(error);
  }
});

router.post("/imports", async (req, res, next) => {
  try {
    const user = authedUser(res);
    const dossierId = asUuid(req.body?.dossierId);
    const fileName =
      typeof req.body?.fileName === "string"
        ? req.body.fileName.trim()
        : "";
    const fileDataJson: unknown = req.body?.fileDataJson;

    if (!dossierId) {
      res.status(403).json({ error: "Dossier inaccessible." });
      return;
    }

    const membership = await dossierMembership(user.id, dossierId);

    if (!membership) {
      res.status(403).json({ error: "Dossier inaccessible." });
      return;
    }

    if (membership.role === "client") {
      res.status(403).json({
        error:
          "Lecture seule : un compte client ne peut pas importer de données.",
      });
      return;
    }

    if (
      !fileName ||
      fileName.length > 255 ||
      !fileDataJson ||
      typeof fileDataJson !== "object" ||
      Array.isArray(fileDataJson)
    ) {
      res.status(400).json({
        error: "Les métadonnées du fichier sont invalides.",
      });
      return;
    }

    const serialized = JSON.stringify(fileDataJson);

    if (serialized.length > 45_000_000) {
      res.status(413).json({
        error:
          "Le fichier structuré dépasse la limite de stockage (45 Mo). Importez-le par période ou par feuille.",
      });
      return;
    }

    // Le navigateur possède déjà les données du fichier :
    // ne pas lui renvoyer tout le JSON après l'enregistrement.
    const [record] = await db
      .insert(imports)
      .values({
        dossierId,
        fileName,
        fileDataJson: fileDataJson as Record<string, unknown>,
      })
      .returning({
        id: imports.id,
        createdAt: imports.createdAt,
      });

    if (!record?.id) {
      res.status(500).json({
        error: "L’import n’a pas pu être enregistré. Réessayez.",
      });
      return;
    }

    res.status(201).json({ import: record });
  } catch (error) {
    next(error);
  }
});

router.get("/constats", async (req, res, next) => {
  try {
    const user = authedUser(res);
    const dossierId = asUuid(req.query.dossierId);

    if (!dossierId || !(await dossierMembership(user.id, dossierId))) {
      res.status(403).json({ error: "Dossier inaccessible." });
      return;
    }

    // Scoped through the dossier's own imports, so a constat can never leak
    // across cabinets even if an id were guessed. Columns are listed
    // explicitly: a bare `select()` with a join returns rows keyed by table
    // name, and the UI expects flat constat objects.
    const records = await db
      .select({
        id: constats.id,
        importId: constats.importId,
        ruleCode: constats.ruleCode,
        severity: constats.severity,
        amount: constats.amount,
        explanation: constats.explanation,
        cellReference: constats.cellReference,
        status: constats.status,
        proposedCorrection: constats.proposedCorrection,
        createdAt: constats.createdAt,
        updatedAt: constats.updatedAt,
      })
      .from(constats)
      .innerJoin(imports, eq(constats.importId, imports.id))
      .where(eq(imports.dossierId, dossierId));

    res.json({ constats: records });
  } catch (error) {
    next(error);
  }
});

/** PostgreSQL caps a statement at 65535 bind parameters; stay well under it. */
const UPSERT_CHUNK = 400;

router.put(
  "/dossiers/:dossierId/constats/sync",
  async (req, res, next) => {
    try {
      const user = authedUser(res);
      const dossierId = asUuid(req.params.dossierId);
      const importId = asUuid(req.body?.importId);
      const incoming = Array.isArray(req.body?.constats)
        ? req.body.constats
        : null;

      if (!dossierId || !importId) {
        res.status(403).json({ error: "Dossier ou import inaccessible." });
        return;
      }

      const membership = await dossierMembership(user.id, dossierId);

      if (!membership) {
        res.status(403).json({ error: "Dossier ou import inaccessible." });
        return;
      }

      if (membership.role === "client") {
        res.status(403).json({
          error:
            "Lecture seule : un compte client ne peut pas modifier les constats.",
        });
        return;
      }

      const importRecord = await importMembership(user.id, importId);

      if (!importRecord) {
        res.status(403).json({ error: "Dossier ou import inaccessible." });
        return;
      }

      if (importRecord.dossierId !== dossierId) {
        res.status(400).json({
          error: "L’import ne correspond pas au dossier actif.",
        });
        return;
      }

      if (!incoming || incoming.length > 5000) {
        res.status(400).json({
          error:
            "La liste des constats est invalide ou dépasse 5 000 éléments.",
        });
        return;
      }

      const validStatuses = new Set([
        "A_EXAMINER",
        "VERIFIE",
        "ECARTE",
      ]);

      const seen = new Set<string>();
      const rows = incoming
        .map((item: any) => {
          const status = validStatuses.has(item?.status)
            ? item.status
            : "A_EXAMINER";

          return {
            id: String(item?.id || "").slice(0, 500),
            importId,
            ruleCode: String(item?.ruleCode || "UNKNOWN").slice(0, 80),
            severity: String(item?.severity || "medium").slice(0, 30),
            amount: Number.isFinite(Number(item?.amount))
              ? Number(item.amount)
              : 0,
            explanation: String(item?.explanation || "").slice(0, 12000),
            cellReference: String(item?.cellReference || "").slice(0, 2000),
            status,
            proposedCorrection:
              item?.proposedCorrection &&
              typeof item.proposedCorrection === "object"
                ? item.proposedCorrection
                : null,
            updatedAt: new Date(),
          };
        })
        .filter(
          (item: { id: string; explanation: string }) =>
            Boolean(item.id && item.explanation),
        )
        // A duplicated id inside one statement raises
        // "ON CONFLICT DO UPDATE command cannot affect row a second time".
        .filter((item: { id: string }) => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });

      if (rows.length) {
        for (let offset = 0; offset < rows.length; offset += UPSERT_CHUNK) {
          const chunk = rows.slice(offset, offset + UPSERT_CHUNK);

          // One statement per chunk instead of one UPDATE per constat: the
          // previous per-row loop issued thousands of sequential round trips,
          // which is what made a large import appear to hang forever.
          //
          // `setWhere` keeps the write tenant-safe: an id that already exists
          // under a *different* import is left untouched rather than
          // overwritten, and `status` is never reset, so the auditor's own
          // decision survives a re-sync.
          await db
            .insert(constats)
            .values(chunk)
            .onConflictDoUpdate({
              target: constats.id,
              set: {
                ruleCode: sql`excluded.rule_code`,
                severity: sql`excluded.severity`,
                amount: sql`excluded.amount`,
                explanation: sql`excluded.explanation`,
                cellReference: sql`excluded.cell_reference`,
                updatedAt: new Date(),
              },
              setWhere: eq(constats.importId, importId),
            });
        }
      }

      // Ne jamais renvoyer un constat appartenant à un autre import.
      const saved = rows.length
        ? await db
            .select()
            .from(constats)
            .where(
              and(
                eq(constats.importId, importId),
                inArray(
                  constats.id,
                  rows.map((item: { id: string }) => item.id),
                ),
              ),
            )
        : [];

      res.json({ constats: saved });
    } catch (error) {
      next(error);
    }
  },
);

router.patch("/constats/:id", async (req, res, next) => {
  try {
    const user = authedUser(res);
    const id = typeof req.params.id === "string" ? req.params.id : "";

    if (!id || id.length > 500) {
      res.status(404).json({ error: "Constat introuvable." });
      return;
    }

    const [existing] = await db
      .select()
      .from(constats)
      .where(eq(constats.id, id))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Constat introuvable." });
      return;
    }

    const membership = await importMembership(user.id, existing.importId);

    if (!membership) {
      res.status(404).json({ error: "Constat introuvable." });
      return;
    }

    if (membership.role === "client") {
      res.status(403).json({
        error:
          "Lecture seule : un compte client ne peut pas modifier les constats.",
      });
      return;
    }

    const status = req.body?.status;

    if (
      status !== undefined &&
      !["A_EXAMINER", "VERIFIE", "ECARTE"].includes(status)
    ) {
      res.status(400).json({ error: "Statut invalide." });
      return;
    }

    let proposedCorrection = existing.proposedCorrection;

    if (Object.hasOwn(req.body || {}, "proposedCorrection")) {
      const candidate = req.body.proposedCorrection;
      const serialized = JSON.stringify(candidate);

      if (serialized && serialized.length > 30000) {
        res.status(413).json({
          error: "La proposition dépasse la taille autorisée.",
        });
        return;
      }

      proposedCorrection =
        candidate && typeof candidate === "object" ? candidate : null;
    }

    // Keep the import in the predicate: the row was authorised through it.
    const [updated] = await db
      .update(constats)
      .set({
        ...(status ? { status } : {}),
        ...(Object.hasOwn(req.body || {}, "proposedCorrection")
          ? { proposedCorrection }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(constats.id, id), eq(constats.importId, existing.importId)))
      .returning();

    res.json({ constat: updated });
  } catch (error) {
    next(error);
  }
});

export default router;
