import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/auth";
import rateLimit from "express-rate-limit";
import { buildReviewInput, reviewAggregatedAnswer, REVIEW_SYSTEM_PROMPT, reviewSchema } from "../lib/ai-review";
import { createGroqClient, GROQ_MODEL, groqChat } from "../lib/groq";
import {
  ReviewAuditWithAiBody,
  ReviewAuditWithAiResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();
router.use(requireAuth);

const aiRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Limite d’analyses IA atteinte. Réessayez dans une minute." },
});
const DAILY_REVIEW_LIMIT = 60;
let dailyReviewCount = 0;
let dailyReviewDate = new Date().toISOString().slice(0, 10);

function consumeDailyReviewQuota(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailyReviewDate) {
    dailyReviewDate = today;
    dailyReviewCount = 0;
  }
  if (dailyReviewCount >= DAILY_REVIEW_LIMIT) return false;
  dailyReviewCount += 1;
  return true;
}

router.post("/audit/ai-review", aiRateLimit, async (req, res): Promise<void> => {
  const fetchSite = req.get("sec-fetch-site");
  const allowedOrigin = process.env.APP_ORIGIN?.trim().replace(/\/$/, "");
  if (fetchSite === "cross-site" && (!allowedOrigin || req.get("origin") !== allowedOrigin)) {
    res.status(403).json({ error: "La revue IA doit être demandée depuis l’application autorisée." });
    return;
  }

  const parsed = ReviewAuditWithAiBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn(
      { validationError: parsed.error.message },
      "Rejected invalid audit AI review request",
    );
    res.status(400).json({ error: "Les données agrégées sont invalides." });
    return;
  }

  const client = createGroqClient();
  if (!client) {
    res.status(503).json({
      error: "L’analyse IA n’est pas configurée. Les contrôles mathématiques restent disponibles.",
    });
    return;
  }
  if (!consumeDailyReviewQuota()) {
    res.status(429).json({
      error: "La limite quotidienne de revues IA est atteinte. Les contrôles locaux restent disponibles.",
    });
    return;
  }

  const input = buildReviewInput(parsed.data);

  try {
    const result = await groqChat(client, {
      model: GROQ_MODEL,
      // Kept within the Groq free-plan tokens-per-minute budget; reasoning tokens share it.
      max_completion_tokens: 4096,
      reasoning_effort: "low",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "moroccan_accounting_audit_review",
          strict: true,
          schema: reviewSchema,
        },
      },
      messages: [
        {
          role: "system",
          content: REVIEW_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: JSON.stringify(input),
        },
      ],
    });

    const content = result.choices[0]?.message.content;
    if (!content) {
      req.log.warn("Audit AI returned an empty result");
      res.status(503).json({ error: "L’analyse IA n’a pas produit de résultat exploitable." });
      return;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(content);
    } catch {
      req.log.warn("Audit AI returned invalid JSON");
      res.status(503).json({ error: "La réponse IA n’a pas pu être validée." });
      return;
    }

    const response = ReviewAuditWithAiResponse.safeParse(reviewAggregatedAnswer(decoded));
    if (!response.success) {
      req.log.warn(
        { validationError: response.error.message },
        "Audit AI response failed validation",
      );
      res.status(503).json({ error: "La réponse IA n’a pas pu être validée." });
      return;
    }

    res.json(response.data);
  } catch (error) {
    req.log.error(
      { error: error instanceof Error ? error.message : "Unknown AI provider error" },
      "Audit AI review failed",
    );
    res.status(503).json({
      error: "Le service IA est temporairement indisponible. Réessayez plus tard.",
    });
  }
});

export default router;
