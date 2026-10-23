/**
 * A local, OpenAI-compatible stand-in for Groq, used through GROQ_BASE_URL so the hybrid audit
 * suites run with no network, no cost and the same answer every time.
 *
 * It answers like Groq does: `usage` in the body, `x-ratelimit-*` headers (requests per day,
 * tokens per minute), 429 with `retry-after`, 401 for a refused key. The semantic answer is
 * built from the rows actually received, so batching is exercised for real, and it always adds
 * two predictions the server must discard (unknown code, row index outside the batch).
 */
import { createServer } from "node:http";

export const INVALID_KEY = "gsk_test_refused";
export const REQUESTS_PER_DAY = 1000;
export const TOKENS_PER_MINUTE = 8000;
const COMPLETION_TOKENS = 200;

/** Level 2 cues the fake recognises in a row's wording: what a real model is expected to flag. */
const SEMANTIC_CUES = [
  { pattern: /^TVA restaurant/i, account: /^3455/, code: "IA-TVA-01", explanation: "Le libellé « TVA restaurant » porte une TVA récupérée sur une dépense de restauration." },
  { pattern: /restaurant/i, account: /^6/, code: "IA-LIB-01", explanation: "Le libellé « Restaurant » est imputé en achats de marchandises." },
  { pattern: /ordinateur/i, account: /^6/, code: "IA-IMM-01", explanation: "Le libellé « Ordinateur portable » désigne un bien durable passé en charge." },
];

function semanticAnswer(input) {
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const findings = [];
  for (const row of rows) {
    const [index, , account, , , description] = row;
    const cue = SEMANTIC_CUES.find((item) => item.pattern.test(String(description)) && item.account.test(String(account)));
    if (cue) findings.push({ code: cue.code, severity: "high", confidence: "élevée", explanation: cue.explanation, rowIndices: [index] });
  }
  // Two hallucinations the server must drop.
  findings.push({ code: "IA-XXX-99", severity: "high", confidence: "élevée", explanation: "Code inventé.", rowIndices: [rows[0]?.[0] ?? 0] });
  findings.push({ code: "IA-AUT-01", severity: "medium", confidence: "faible", explanation: "Ligne hors du lot.", rowIndices: [999_999] });
  return { findings, coverageNote: `Lot de ${rows.length} ligne(s) lu.` };
}

function correctionAnswer(input) {
  const amount = Math.abs(Number(input.amount) || 0);
  const source = Array.isArray(input.sourceRows) && input.sourceRows[0]?.accountCode ? input.sourceRows[0].accountCode : "6111";
  return {
    description: "Reclasser la dépense de restauration vers le compte 6132.",
    journalEntry: [
      { accountCode: "6132", accountLabel: "Restauration", debit: amount, credit: 0, rationale: "Nature réelle de la dépense." },
      { accountCode: source, accountLabel: "Compte imputé à tort", debit: 0, credit: amount, rationale: "Annule l’imputation initiale." },
    ],
    prerequisites: ["Rapprocher la facture du restaurant."],
    confidence: "moyenne",
    disclaimer: "Brouillon à valider.",
  };
}

const reviewAnswer = () => ({ executiveSummary: "Synthèse de test.", priorities: [], limitations: "Réponse du faux Groq." });

export async function startFakeGroq() {
  const calls = [];
  const forced = [];
  let requestsLeft = REQUESTS_PER_DAY;

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const key = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const send = (status, payload, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(payload));
      };
      if (key === INVALID_KEY) { send(401, { error: { message: "Invalid API Key", type: "invalid_request_error" } }); return; }
      if (req.method === "GET" && req.url.endsWith("/models")) { send(200, { object: "list", data: [{ id: "openai/gpt-oss-120b", object: "model" }] }); return; }
      if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { send(404, { error: { message: "not found" } }); return; }

      const request = JSON.parse(body || "{}");
      const schema = request.response_format?.json_schema?.name || "";
      let input = {};
      try { input = JSON.parse(request.messages?.findLast((message) => message.role === "user")?.content || "{}"); } catch { input = {}; }
      calls.push({ schema, input, key });

      const next = forced.shift();
      if (next?.status === 429) {
        // retry-after-ms keeps the SDK's own retries fast; retry-after is what the API relays.
        send(429, { error: { message: "Rate limit reached", type: "tokens" } }, { "retry-after": String(next.retryAfter ?? 1), "retry-after-ms": "5" });
        return;
      }

      const answer = schema === "mizan_semantic_review" ? semanticAnswer(input)
        : schema === "mizan_accounting_correction" ? correctionAnswer(input)
          : reviewAnswer();
      const promptTokens = Math.ceil(body.length / 4);
      requestsLeft -= 1;
      calls.at(-1).usage = { prompt_tokens: promptTokens, completion_tokens: COMPLETION_TOKENS, total_tokens: promptTokens + COMPLETION_TOKENS };
      send(200, {
        id: `chatcmpl-test-${calls.length}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(answer) } }],
        usage: { prompt_tokens: promptTokens, completion_tokens: COMPLETION_TOKENS, total_tokens: promptTokens + COMPLETION_TOKENS },
      }, {
        "x-ratelimit-limit-requests": String(REQUESTS_PER_DAY),
        "x-ratelimit-remaining-requests": String(requestsLeft),
        "x-ratelimit-reset-requests": "1m26.4s",
        "x-ratelimit-limit-tokens": String(TOKENS_PER_MINUTE),
        "x-ratelimit-remaining-tokens": String(Math.max(0, TOKENS_PER_MINUTE - promptTokens - COMPLETION_TOKENS)),
        "x-ratelimit-reset-tokens": "7.5s",
      });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/openai/v1`,
    calls,
    /** The next `count` completions answer 429 (the SDK retries twice on its own, so 3 reach the API). */
    rateLimitNext(count = 3, retryAfter = 1) { for (let i = 0; i < count; i += 1) forced.push({ status: 429, retryAfter }); },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
