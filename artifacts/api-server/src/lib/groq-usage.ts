// In-memory record of this server's Groq usage, reset at midnight UTC or on restart.
// Groq does not expose a billing or plan API: the daily token count is local to this process,
// while the rate-limit headers describe the whole Groq organisation behind the key.

export type GroqPlan = "free" | "paid";
export type KeyStatus = "not_configured" | "active" | "limit_reached" | "invalid";

export type RateLimitHeaders = {
  /** Requests per day (RPD) allowed for the model. */
  limitRequests: number | null;
  remainingRequests: number | null;
  resetRequests: string | null;
  /** Tokens per minute (TPM) allowed for the model. */
  limitTokens: number | null;
  remainingTokens: number | null;
  resetTokens: string | null;
  observedAt: string;
};

export type UsageConfig = {
  plan: GroqPlan;
  dailyTokenLimit: number;
  dailyRequestLimit: number;
};

export type UsageSnapshot = {
  configured: boolean;
  model: string;
  plan: GroqPlan;
  day: string;
  requests: number;
  failedRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  dailyTokenLimit: number;
  dailyRequestLimit: number;
  /** Requests counted for the day: Groq's own figure when its headers were seen, else this server's. */
  requestsToday: number;
  tokenPercent: number;
  requestPercent: number;
  usagePercent: number;
  keyStatus: KeyStatus;
  lastCallAt: string | null;
  lastError: string | null;
  retryAfterSeconds: number | null;
  rateLimit: RateLimitHeaders | null;
};

// Groq's published limits for openai/gpt-oss-120b on the free plan.
export const FREE_PLAN_DAILY_TOKENS = 200_000;
export const FREE_PLAN_DAILY_REQUESTS = 1_000;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function usageConfigFromEnv(env: NodeJS.ProcessEnv = process.env): UsageConfig {
  return {
    plan: env.GROQ_PLAN?.trim().toLowerCase() === "paid" ? "paid" : "free",
    dailyTokenLimit: positiveInteger(env.GROQ_DAILY_TOKEN_LIMIT, FREE_PLAN_DAILY_TOKENS),
    dailyRequestLimit: positiveInteger(env.GROQ_DAILY_REQUEST_LIMIT, FREE_PLAN_DAILY_REQUESTS),
  };
}

type HeaderSource = { get(name: string): string | null } | Record<string, string | string[] | undefined> | undefined | null;

function readHeader(headers: HeaderSource, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === "function") return (headers as { get(name: string): string | null }).get(name);
  const value = (headers as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function numberHeader(headers: HeaderSource, name: string): number | null {
  const raw = readHeader(headers, name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function parseRateLimitHeaders(headers: HeaderSource, now: Date): RateLimitHeaders | null {
  const parsed = {
    limitRequests: numberHeader(headers, "x-ratelimit-limit-requests"),
    remainingRequests: numberHeader(headers, "x-ratelimit-remaining-requests"),
    resetRequests: readHeader(headers, "x-ratelimit-reset-requests"),
    limitTokens: numberHeader(headers, "x-ratelimit-limit-tokens"),
    remainingTokens: numberHeader(headers, "x-ratelimit-remaining-tokens"),
    resetTokens: readHeader(headers, "x-ratelimit-reset-tokens"),
  };
  if (Object.values(parsed).every((value) => value === null)) return null;
  return { ...parsed, observedAt: now.toISOString() };
}

type TokenUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null | undefined;

const percent = (used: number, limit: number) => (limit > 0 ? Math.min(100, Math.round((used / limit) * 1000) / 10) : 0);

export function createUsageTracker(config: UsageConfig, now: () => Date = () => new Date()) {
  const dayOf = (date: Date) => date.toISOString().slice(0, 10);
  let state = {
    day: dayOf(now()),
    requests: 0,
    failedRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    lastCallAt: null as string | null,
    lastError: null as string | null,
    invalidKey: false,
    limitedUntil: null as number | null,
    rateLimit: null as RateLimitHeaders | null,
  };
  const rollDay = () => {
    const today = dayOf(now());
    if (today !== state.day) {
      // Header values describe the previous day's quota and are dropped with it.
      state = { ...state, day: today, requests: 0, failedRequests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, rateLimit: null, limitedUntil: null, lastError: null };
    }
  };

  return {
    recordSuccess(usage: TokenUsage, headers: HeaderSource) {
      rollDay();
      const at = now();
      const prompt = Math.max(0, Number(usage?.prompt_tokens) || 0);
      const completion = Math.max(0, Number(usage?.completion_tokens) || 0);
      const total = Math.max(prompt + completion, Number(usage?.total_tokens) || 0);
      state.requests += 1;
      state.promptTokens += prompt;
      state.completionTokens += completion;
      state.totalTokens += total;
      state.lastCallAt = at.toISOString();
      state.lastError = null;
      state.invalidKey = false;
      state.limitedUntil = null;
      state.rateLimit = parseRateLimitHeaders(headers, at) ?? state.rateLimit;
    },
    recordFailure(error: unknown) {
      rollDay();
      const at = now();
      const status = typeof error === "object" && error !== null && "status" in error ? Number((error as { status: unknown }).status) : 0;
      const headers = typeof error === "object" && error !== null && "headers" in error ? (error as { headers: HeaderSource }).headers : null;
      state.requests += 1;
      state.failedRequests += 1;
      state.lastCallAt = at.toISOString();
      state.rateLimit = parseRateLimitHeaders(headers, at) ?? state.rateLimit;
      if (status === 401 || status === 403) {
        state.invalidKey = true;
        state.lastError = "Clé refusée par Groq";
      } else if (status === 429) {
        const retryAfter = numberHeader(headers, "retry-after");
        state.limitedUntil = at.getTime() + Math.max(1, retryAfter ?? 60) * 1000;
        state.lastError = "Limite de débit Groq atteinte";
      } else {
        state.lastError = status ? `Erreur Groq ${status}` : "Groq injoignable";
      }
    },
    recordKeyCheck(valid: boolean) {
      rollDay();
      state.invalidKey = !valid;
      if (valid && state.lastError === "Clé refusée par Groq") state.lastError = null;
      if (!valid) state.lastError = "Clé refusée par Groq";
    },
    snapshot(configured: boolean, model: string): UsageSnapshot {
      rollDay();
      const at = now().getTime();
      const header = state.rateLimit;
      const headerUsed = header?.limitRequests != null && header.remainingRequests != null ? Math.max(0, header.limitRequests - header.remainingRequests) : null;
      const requestLimit = header?.limitRequests ?? config.dailyRequestLimit;
      const requestsToday = headerUsed ?? state.requests;
      const tokenPercent = percent(state.totalTokens, config.dailyTokenLimit);
      const requestPercent = percent(requestsToday, requestLimit);
      const limited = state.limitedUntil !== null && state.limitedUntil > at;
      const exhausted = tokenPercent >= 100 || requestPercent >= 100 || header?.remainingRequests === 0;
      const keyStatus: KeyStatus = !configured ? "not_configured" : state.invalidKey ? "invalid" : limited || exhausted ? "limit_reached" : "active";
      return {
        configured,
        model,
        plan: config.plan,
        day: state.day,
        requests: state.requests,
        failedRequests: state.failedRequests,
        promptTokens: state.promptTokens,
        completionTokens: state.completionTokens,
        totalTokens: state.totalTokens,
        dailyTokenLimit: config.dailyTokenLimit,
        dailyRequestLimit: requestLimit,
        requestsToday,
        tokenPercent,
        requestPercent,
        usagePercent: Math.max(tokenPercent, requestPercent),
        keyStatus,
        lastCallAt: state.lastCallAt,
        lastError: state.lastError,
        retryAfterSeconds: limited ? Math.ceil((state.limitedUntil! - at) / 1000) : null,
        rateLimit: header,
      };
    },
  };
}

export type UsageTracker = ReturnType<typeof createUsageTracker>;
