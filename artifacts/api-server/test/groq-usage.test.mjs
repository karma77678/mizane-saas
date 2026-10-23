/**
 * Offline tests for the Groq usage tracker behind the "Consommation IA" page.
 *
 *   node --test artifacts/api-server/test/groq-usage.test.mjs
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createUsageTracker, FREE_PLAN_DAILY_REQUESTS, FREE_PLAN_DAILY_TOKENS, parseRateLimitHeaders, usageConfigFromEnv } from "../src/lib/groq-usage.ts";

const CONFIG = { plan: "free", dailyTokenLimit: 10_000, dailyRequestLimit: 100 };
function clock(start = "2026-10-22T10:00:00Z") {
  let now = new Date(start);
  return { now: () => now, advance: (ms) => { now = new Date(now.getTime() + ms); }, set: (value) => { now = new Date(value); } };
}
const headers = (values) => new Headers(values);

describe("usageConfigFromEnv", () => {
  it("defaults to Groq's free-plan limits for gpt-oss-120b", () => {
    assert.deepEqual(usageConfigFromEnv({}), { plan: "free", dailyTokenLimit: FREE_PLAN_DAILY_TOKENS, dailyRequestLimit: FREE_PLAN_DAILY_REQUESTS });
  });
  it("reads the declared plan and limits, ignoring invalid values", () => {
    assert.deepEqual(usageConfigFromEnv({ GROQ_PLAN: "Paid", GROQ_DAILY_TOKEN_LIMIT: "500000", GROQ_DAILY_REQUEST_LIMIT: "-3" }), { plan: "paid", dailyTokenLimit: 500_000, dailyRequestLimit: FREE_PLAN_DAILY_REQUESTS });
  });
});

describe("parseRateLimitHeaders", () => {
  it("reads Groq's headers from a Headers object or a plain record", () => {
    const now = new Date("2026-10-22T10:00:00Z");
    const fromHeaders = parseRateLimitHeaders(headers({ "x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "990", "x-ratelimit-limit-tokens": "8000", "x-ratelimit-remaining-tokens": "5000", "x-ratelimit-reset-tokens": "22.5s" }), now);
    assert.equal(fromHeaders.limitRequests, 1000);
    assert.equal(fromHeaders.remainingTokens, 5000);
    assert.equal(fromHeaders.resetTokens, "22.5s");
    assert.equal(parseRateLimitHeaders({ "x-ratelimit-limit-requests": "1000" }, now).limitRequests, 1000);
    assert.equal(parseRateLimitHeaders(headers({}), now), null);
  });
});

describe("createUsageTracker", () => {
  it("is not configured without a key, active with one", () => {
    const tracker = createUsageTracker(CONFIG, clock().now);
    assert.equal(tracker.snapshot(false, "m").keyStatus, "not_configured");
    assert.equal(tracker.snapshot(true, "m").keyStatus, "active");
  });
  it("adds requests and tokens, and gives the percentage of the daily limit", () => {
    const tracker = createUsageTracker(CONFIG, clock().now);
    tracker.recordSuccess({ prompt_tokens: 1500, completion_tokens: 500, total_tokens: 2000 }, headers({}));
    tracker.recordSuccess({ prompt_tokens: 400, completion_tokens: 100, total_tokens: 500 }, null);
    const snap = tracker.snapshot(true, "m");
    assert.equal(snap.requests, 2);
    assert.equal(snap.totalTokens, 2500);
    assert.equal(snap.tokenPercent, 25);
    assert.equal(snap.requestPercent, 2);
    assert.equal(snap.usagePercent, 25);
  });
  it("prefers Groq's own daily request count when its headers were seen", () => {
    const tracker = createUsageTracker(CONFIG, clock().now);
    tracker.recordSuccess({ total_tokens: 10 }, headers({ "x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "750" }));
    const snap = tracker.snapshot(true, "m");
    assert.equal(snap.requestsToday, 250);
    assert.equal(snap.dailyRequestLimit, 1000);
    assert.equal(snap.requestPercent, 25);
  });
  it("reports the limit as reached after a 429, until retry-after has passed", () => {
    const time = clock();
    const tracker = createUsageTracker(CONFIG, time.now);
    tracker.recordFailure({ status: 429, headers: headers({ "retry-after": "30" }) });
    let snap = tracker.snapshot(true, "m");
    assert.equal(snap.keyStatus, "limit_reached");
    assert.equal(snap.retryAfterSeconds, 30);
    assert.equal(snap.failedRequests, 1);
    time.advance(31_000);
    snap = tracker.snapshot(true, "m");
    assert.equal(snap.keyStatus, "active");
    assert.equal(snap.retryAfterSeconds, null);
  });
  it("reports the limit as reached when the daily token budget is used", () => {
    const tracker = createUsageTracker(CONFIG, clock().now);
    tracker.recordSuccess({ total_tokens: 10_000 }, null);
    assert.equal(tracker.snapshot(true, "m").keyStatus, "limit_reached");
    assert.equal(tracker.snapshot(true, "m").usagePercent, 100);
  });
  it("marks a refused key as invalid, and clears it after a successful check", () => {
    const tracker = createUsageTracker(CONFIG, clock().now);
    tracker.recordFailure({ status: 401 });
    assert.equal(tracker.snapshot(true, "m").keyStatus, "invalid");
    tracker.recordKeyCheck(true);
    assert.equal(tracker.snapshot(true, "m").keyStatus, "active");
  });
  it("starts a new day at midnight UTC", () => {
    const time = clock("2026-10-22T23:59:00Z");
    const tracker = createUsageTracker(CONFIG, time.now);
    tracker.recordSuccess({ total_tokens: 9000 }, headers({ "x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "1" }));
    time.set("2026-10-23T00:01:00Z");
    const snap = tracker.snapshot(true, "m");
    assert.equal(snap.day, "2026-10-23");
    assert.equal(snap.totalTokens, 0);
    assert.equal(snap.rateLimit, null);
    assert.equal(snap.requestsToday, 0);
  });
});
