import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { buildSemanticInput, MAX_SEMANTIC_ROWS, reviewSemanticAnswer, sanitizeSemanticRows, SEMANTIC_SYSTEM_PROMPT, semanticSchema } from "../lib/semantic-review";
import { createGroqClient, GROQ_MODEL, groqChat, groqRetryAfter } from "../lib/groq";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();
router.use(requireAuth);

// One request per batch; Groq's own 30 requests per minute stays the outer bound.
const semanticRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de lots IA envoyés en une minute. Patientez avant de reprendre." },
});

router.post("/audit/semantic-review", semanticRateLimit, async (req, res): Promise<void> => {
  const fetchSite = req.get("sec-fetch-site");
  const allowedOrigin = process.env.APP_ORIGIN?.trim().replace(/\/$/, "");
  if (fetchSite === "cross-site" && (!allowedOrigin || req.get("origin") !== allowedOrigin)) {
    res.status(403).json({ error: "L’analyse IA doit être demandée depuis l’application autorisée." });
    return;
  }
  const rows = sanitizeSemanticRows(req.body?.rows);
  if (!rows) {
    res.status(400).json({ error: `Le lot doit contenir entre 1 et ${MAX_SEMANTIC_ROWS} lignes indexées.` });
    return;
  }
  const year = Number(req.body?.fiscalYear);
  const fiscalYear = Number.isInteger(year) && year >= 1990 && year <= 2100 ? year : null;
  const client = createGroqClient();
  if (!client) {
    res.status(503).json({ error: "L’IA n’est pas configurée. Ajoutez GROQ_API_KEY ; le Niveau 1 déterministe reste disponible." });
    return;
  }
  try {
    const result = await groqChat(client, {
      model: GROQ_MODEL,
      max_completion_tokens: 3072,
      reasoning_effort: "low",
      response_format: { type: "json_schema", json_schema: { name: "mizan_semantic_review", strict: true, schema: semanticSchema } },
      messages: [
        { role: "system", content: SEMANTIC_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(buildSemanticInput(rows, fiscalYear)) },
      ],
    });
    const content = result.choices[0]?.message.content;
    let decoded: unknown = null;
    try { decoded = content ? JSON.parse(content) : null; } catch { decoded = null; }
    if (!decoded) {
      // finish_reason "length" means the reasoning used up the token budget before the JSON.
      req.log.warn({ finishReason: result.choices[0]?.finish_reason, tokens: result.usage?.total_tokens }, "Semantic review answer unreadable");
      res.status(503).json({ error: "La réponse IA n’a pas pu être lue pour ce lot." });
      return;
    }
    const reviewed = reviewSemanticAnswer(decoded, rows);
    // Counts only: no row content from the client file is logged.
    req.log.info({ rows: rows.length, findings: reviewed.findings.length, discarded: reviewed.discarded, tokens: result.usage?.total_tokens }, "Semantic review batch");
    res.json({ findings: reviewed.findings, coverageNote: reviewed.coverageNote, discarded: reviewed.discarded, analysedRows: rows.length });
  } catch (error) {
    const retryAfter = groqRetryAfter(error);
    if (retryAfter !== null) {
      res.set("Retry-After", String(retryAfter));
      res.status(429).json({ error: "Limite de débit Groq atteinte.", retryAfterSeconds: retryAfter });
      return;
    }
    req.log.error({ error: error instanceof Error ? error.message : "Unknown AI provider error" }, "Semantic review batch failed");
    res.status(503).json({ error: "Le service IA est temporairement indisponible pour ce lot." });
  }
});

export default router;
