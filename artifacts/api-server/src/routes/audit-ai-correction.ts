import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { buildCorrectionInput, correctionSchema, CORRECTION_SYSTEM_PROMPT, entryIsRequired, MAX_SOURCE_ROWS, reviewProposalWithReason } from "../lib/ai-correction";
import { createGroqClient, GROQ_MODEL, groqChat } from "../lib/groq";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();
router.use(requireAuth);
// Attached to the route, not with router.use: this router is mounted on /api ahead of others,
// and a router-level limiter would also count their requests (Level 2 batches, usage polling).
const correctionRateLimit = rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: true, legacyHeaders: false });

router.post("/audit/ai-correction", correctionRateLimit, async (req, res): Promise<void> => {
  const fetchSite = req.get("sec-fetch-site");
  const allowedOrigin = process.env.APP_ORIGIN?.trim().replace(/\/$/, "");
  if (fetchSite === "cross-site" && (!allowedOrigin || req.get("origin") !== allowedOrigin)) {
    res.status(403).json({ error: "La proposition IA doit être demandée depuis l’application autorisée." });
    return;
  }
  const client = createGroqClient();
  if (!client) { res.status(503).json({ error: "L’IA n’est pas configurée. Ajoutez GROQ_API_KEY dans les Secrets du projet." }); return; }
  const finding = req.body?.finding;
  const rows = Array.isArray(req.body?.sourceRows) ? req.body.sourceRows : [];
  if (!finding || typeof finding !== "object" || rows.length > MAX_SOURCE_ROWS) { res.status(400).json({ error: "Le constat ou les lignes sources ne sont pas valides." }); return; }
  const input = buildCorrectionInput(finding, rows);
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: CORRECTION_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(input) },
  ];
  const askModel = async () => {
    const result = await groqChat(client, {
      model: GROQ_MODEL,
      // Reasoning tokens share this budget with the JSON answer.
      max_completion_tokens: 4096,
      reasoning_effort: "medium",
      response_format: { type: "json_schema", json_schema: { name: "mizan_accounting_correction", strict: true, schema: correctionSchema } },
      messages,
    });
    const content = result.choices[0]?.message.content;
    if (!content) return null;
    const decoded = JSON.parse(content) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    return { content, decoded: decoded as Record<string, unknown> };
  };
  try {
    let answer = await askModel();
    if (!answer) { res.status(503).json({ error: "Réponse IA vide ou invalide." }); return; }
    let reviewed = reviewProposalWithReason(answer.decoded, input);
    const firstRejection = reviewed.rejection;
    // Where a figured entry is required, a text-only or wrong answer gets one corrective retry.
    const retried = Boolean(reviewed.rejection) && entryIsRequired(input);
    if (retried) {
      messages.push(
        { role: "assistant", content: answer.content },
        { role: "user", content: `Proposition refusée par le contrôle automatique : ${reviewed.rejection} Renvoie une proposition complète qui respecte correctionMode et ses montants imposés.` },
      );
      answer = await askModel();
      if (answer) reviewed = reviewProposalWithReason(answer.decoded, input);
    }
    // Rule, mode and server checks only: no finding text, account or amount from the client file.
    req.log.info({
      ruleCode: input.ruleCode,
      correctionMode: input.correctionMode,
      firstAnswerRejected: Boolean(firstRejection),
      retried,
      finalLines: Array.isArray(reviewed.proposal.journalEntry) ? reviewed.proposal.journalEntry.length : 0,
      finalRejected: Boolean(reviewed.rejection),
    }, "AI correction reviewed");
    res.json(reviewed.proposal);
  } catch (error) {
    req.log.error({ error: error instanceof Error ? error.message : "Unknown AI provider error" }, "AI correction proposal failed");
    res.status(503).json({ error: "Impossible de générer une proposition pour le moment." });
  }
});

export default router;
