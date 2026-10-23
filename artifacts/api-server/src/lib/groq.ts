import OpenAI from "openai";
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { createUsageTracker, usageConfigFromEnv } from "./groq-usage";

// Groq exposes an OpenAI-compatible API, so the official OpenAI SDK is reused with Groq's base URL.
// openai/gpt-oss-120b is a Groq production model, available on the free plan, with strict json_schema support.
export const GROQ_MODEL = process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b";
const DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1";

export function createGroqClient(): OpenAI | null {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) return null;
  // GROQ_BASE_URL only redirects to an OpenAI-compatible stand-in, such as the test suites' local fake.
  return new OpenAI({ apiKey, baseURL: process.env.GROQ_BASE_URL?.trim() || DEFAULT_GROQ_BASE_URL });
}

export const groqUsage = createUsageTracker(usageConfigFromEnv());

/** Every Groq completion goes through here so its tokens and rate-limit headers are counted. */
export async function groqChat(client: OpenAI, params: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion> {
  try {
    const { data, response } = await client.chat.completions.create(params).withResponse();
    groqUsage.recordSuccess(data.usage, response.headers);
    return data;
  } catch (error) {
    groqUsage.recordFailure(error);
    throw error;
  }
}

/** Seconds Groq asks to wait after a 429, or null for any other error. */
export function groqRetryAfter(error: unknown): number | null {
  if (!(error instanceof OpenAI.APIError) || error.status !== 429) return null;
  const value = Number(error.headers?.get?.("retry-after"));
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 60;
}
