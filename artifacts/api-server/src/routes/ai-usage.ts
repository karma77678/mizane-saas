import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";
import { createGroqClient, GROQ_MODEL, groqUsage } from "../lib/groq";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();
router.use(requireAuth);

router.get("/ai/usage", (_req, res) => {
  res.json(groqUsage.snapshot(Boolean(createGroqClient()), GROQ_MODEL));
});

// Listing models costs no tokens, so it checks the key without touching the quota.
router.post("/ai/usage/check", rateLimit({ windowMs: 60_000, limit: 6, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
  const client = createGroqClient();
  if (client) {
    try {
      await client.models.list();
      groqUsage.recordKeyCheck(true);
    } catch (error) {
      if (error instanceof OpenAI.APIError && (error.status === 401 || error.status === 403)) groqUsage.recordKeyCheck(false);
      else req.log.warn({ error: error instanceof Error ? error.message : "Unknown" }, "Groq key check failed");
    }
  }
  res.json(groqUsage.snapshot(Boolean(client), GROQ_MODEL));
});

export default router;
