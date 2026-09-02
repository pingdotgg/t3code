import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  nextUsageLimitRetryAt,
  providerUsageLimitFromError,
  retryAtFromEpochSeconds,
  retryAtFromUsageLimitMessage,
} from "./usageLimits.ts";

describe("provider usage limits", () => {
  it("parses a dated production-style reset instead of falling back to the cadence", () => {
    expect(
      retryAtFromUsageLimitMessage(
        "Usage limit reached. Try again at Sep 6th, 2026 1:13 AM.",
        DateTime.makeUnsafe("2026-09-05T20:54:05.027Z"),
        "Europe/Berlin",
      ),
    ).toBe("2026-09-05T23:14:00.000Z");
  });
  it("classifies common subscription and API limit errors", () => {
    for (const message of [
      "Usage limit reached",
      "rate limit exceeded",
      "HTTP 429 Too Many Requests",
      "HTTP 404: Service is temporarily unavailable.",
      "RESOURCE_EXHAUSTED",
      "insufficient_quota",
      "You've hit your Cursor usage limit.",
      "Grok usage limit reached. Try again later.",
      "OpenCode request failed with HTTP 429.",
      "You hit your spend cap set by the owner of your workspace.",
      "The selected model is currently at capacity.",
    ]) {
      expect(providerUsageLimitFromError({ message })).not.toBeNull();
    }
    expect(providerUsageLimitFromError({ message: "Context window exceeded" })).toBeNull();
  });

  it("does not retry a bare 404 or missing provider resources", () => {
    for (const message of [
      "Provider request failed with HTTP 404.",
      "HTTP 404: Model not found.",
      "HTTP 404: Invalid endpoint.",
      "HTTP 404: Session expired.",
    ]) {
      expect(providerUsageLimitFromError({ message })).toBeNull();
      expect(
        providerUsageLimitFromError({
          message: "Request failed",
          detail: { message, status: 404 },
        }),
      ).toBeNull();
    }
  });

  it("parses provider clock times one minute after the advertised reset", () => {
    expect(
      retryAtFromUsageLimitMessage(
        "Try again at 7:41 PM.",
        DateTime.makeUnsafe("2026-09-02T16:43:00.000Z"),
        "Europe/Berlin",
      ),
    ).toBe("2026-09-02T17:42:00.000Z");
  });

  it("extracts nested absolute reset timestamps", () => {
    const timed = providerUsageLimitFromError({
      message: "Usage limit reached. Try again at 7:41 PM.",
      retryAt: "2020-01-01T00:00:00.000Z",
    });
    expect(timed?.retryAt).toBeDefined();
    expect(timed?.retryAt).not.toBe("2020-01-01T00:00:00.000Z");
    expect(
      providerUsageLimitFromError({
        message: "rate limit exceeded",
        detail: { error: { rate_limit: { resetsAt: 1_787_944_200 } } },
      }),
    ).toEqual({ retryAt: "2026-08-28T19:10:00.000Z" });
    expect(retryAtFromEpochSeconds(1_787_944_200)).toBe("2026-08-28T19:10:00.000Z");
  });

  it("classifies structured quota details when the outer message is generic", () => {
    expect(
      providerUsageLimitFromError({
        message: "Provider request failed.",
        detail: { error: { statusCode: 429 } },
      }),
    ).toEqual({});
    expect(
      providerUsageLimitFromError({
        message: "Provider request failed.",
        detail: { error: { code: "insufficient_quota" } },
      }),
    ).toEqual({});
  });

  it("uses the provider reset when available and paced fallback retries otherwise", () => {
    expect(
      nextUsageLimitRetryAt({
        now: "2026-08-28T18:00:00.000Z",
        attempt: 0,
        providerRetryAt: "2026-08-28T18:30:00.000Z",
      }),
    ).toBe("2026-08-28T18:30:02.000Z");
    expect(nextUsageLimitRetryAt({ now: "2026-08-28T18:00:00.000Z", attempt: 0 })).toBe(
      "2026-08-28T18:20:00.000Z",
    );
    expect(nextUsageLimitRetryAt({ now: "2026-08-28T18:00:00.000Z", attempt: 2 })).toBe(
      "2026-08-28T18:20:00.000Z",
    );
    expect(nextUsageLimitRetryAt({ now: "2026-08-28T18:00:00.000Z", attempt: 3 })).toBe(
      "2026-08-28T19:00:00.000Z",
    );
    expect(nextUsageLimitRetryAt({ now: "2026-08-28T18:00:00.000Z", attempt: 7 })).toBe(
      "2026-08-28T19:00:00.000Z",
    );
    expect(nextUsageLimitRetryAt({ now: "2026-08-28T18:00:00.000Z", attempt: 8 })).toBe(
      "2026-08-29T00:00:00.000Z",
    );
  });
});
