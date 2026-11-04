import { describe, expect, it } from "vite-plus/test";

import {
  CODEX_RATE_LIMIT_RETRY_POLICY,
  codexErrorHttpStatusCode,
  codexErrorTextIndicatesHttp429,
  codexRateLimitBackoffMs,
  decideCodexRateLimitRetry,
  parseCodexRetryAfterMs,
} from "./codexRateLimitRetry.ts";

describe("codexRateLimitRetry", () => {
  it("backs off exponentially from the base delay up to the max delay", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => codexRateLimitBackoffMs(attempt))).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
    ]);
  });

  it("waits per Retry-After first, plus the progress grace", () => {
    expect(decideCodexRateLimitRetry({ attempt: 1, retryAfterMs: 30_000 })).toEqual({
      type: "wait",
      delayMs: 30_000,
      deadlineMs: 30_000 + CODEX_RATE_LIMIT_RETRY_POLICY.progressGraceMs,
    });
    expect(decideCodexRateLimitRetry({ attempt: 3, retryAfterMs: null })).toEqual({
      type: "wait",
      delayMs: 20_000,
      deadlineMs: 20_000 + CODEX_RATE_LIMIT_RETRY_POLICY.progressGraceMs,
    });
  });

  it("gives up past the attempt cap or a Retry-After longer than the max delay", () => {
    expect(decideCodexRateLimitRetry({ attempt: 5, retryAfterMs: null }).type).toBe("wait");
    expect(decideCodexRateLimitRetry({ attempt: 6, retryAfterMs: null })).toEqual({
      type: "give_up",
      reason: "attempts_exhausted",
    });
    expect(
      decideCodexRateLimitRetry({
        attempt: 1,
        retryAfterMs: CODEX_RATE_LIMIT_RETRY_POLICY.maxDelayMs + 1,
      }),
    ).toEqual({ type: "give_up", reason: "retry_after_exceeds_max_delay" });
  });

  it("reads retry delays from provider error text", () => {
    expect(parseCodexRetryAfterMs("429 Too Many Requests; Retry-After: 384882")).toBe(384_882_000);
    expect(parseCodexRetryAfterMs('{"retry_after": 1.5}')).toBe(1_500);
    expect(parseCodexRetryAfterMs('{"error":{"reset_seconds":12}}')).toBe(12_000);
    expect(parseCodexRetryAfterMs("Rate limited. Please try again in 2 minutes.")).toBe(120_000);
    expect(parseCodexRetryAfterMs("Reconnecting... 1/5")).toBeNull();
    expect(parseCodexRetryAfterMs(null)).toBeNull();
  });

  it("reads the unit a retry-after delay names", () => {
    expect(parseCodexRetryAfterMs("Rate limited. Please retry after 2 minutes.")).toBe(120_000);
    expect(parseCodexRetryAfterMs("Rate limited; retry after 500ms")).toBe(500);
    expect(parseCodexRetryAfterMs("retry-after: 1 hour")).toBe(3_600_000);
    expect(parseCodexRetryAfterMs("Retry-After: 30s")).toBe(30_000);
    expect(parseCodexRetryAfterMs("retry-after-ms: 250")).toBe(250);
    // A bare Retry-After value stays delay-seconds.
    expect(parseCodexRetryAfterMs("Retry-After: 30; so retry later")).toBe(30_000);
  });

  it("reads an HTTP-date Retry-After as the delay until that date", () => {
    const nowMs = Date.parse("2026-10-22T11:59:30Z");
    expect(
      parseCodexRetryAfterMs(
        "429 Too Many Requests; Retry-After: Thu, 22 Oct 2026 12:00:00 GMT",
        nowMs,
      ),
    ).toBe(30_000);
    expect(parseCodexRetryAfterMs('{"retry-after":"Thu, 22 Oct 2026 13:00:00 GMT"}', nowMs)).toBe(
      3_630_000,
    );
    // A date already in the past allows an immediate retry.
    expect(parseCodexRetryAfterMs("Retry-After: Thu, 22 Oct 2026 11:00:00 GMT", nowMs)).toBe(0);
  });

  it("recognizes HTTP 429 in provider error text", () => {
    expect(codexErrorTextIndicatesHttp429("429 Too Many Requests; Retry-After: 30")).toBe(true);
    expect(codexErrorTextIndicatesHttp429('{"status": 429, "error": "rate_limited"}')).toBe(true);
    expect(codexErrorTextIndicatesHttp429("unexpected status code 429")).toBe(true);
    expect(codexErrorTextIndicatesHttp429("HTTP 429")).toBe(true);
    expect(codexErrorTextIndicatesHttp429("The response stream disconnected.")).toBe(false);
    expect(codexErrorTextIndicatesHttp429("unexpected status 503; request id 4291")).toBe(false);
    expect(codexErrorTextIndicatesHttp429(undefined)).toBe(false);
  });

  it("reads the HTTP status from any structured Codex error", () => {
    expect(codexErrorHttpStatusCode({ responseStreamDisconnected: { httpStatusCode: 429 } })).toBe(
      429,
    );
    expect(codexErrorHttpStatusCode({ httpConnectionFailed: { httpStatusCode: null } })).toBeNull();
    expect(codexErrorHttpStatusCode("usageLimitExceeded")).toBeNull();
    expect(codexErrorHttpStatusCode(null)).toBeNull();
  });
});
