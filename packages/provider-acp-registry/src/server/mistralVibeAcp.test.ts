import { describe, expect, it } from "@effect/vitest";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  MISTRAL_VIBE_RATE_LIMITED,
  mistralVibePromptFailure,
  mistralVibeUsageLimitResetAt,
} from "./mistralVibeAcp.ts";

const nowMs = Date.parse("2026-11-10T12:00:00Z");

describe("mistralVibeUsageLimitResetAt", () => {
  it("reads the reset timestamp a refusal names", () => {
    expect(
      mistralVibeUsageLimitResetAt(
        "Rate limit reached. Your usage window resets at 2026-11-10T12:05:00Z.",
        nowMs,
      ),
    ).toBe("2026-11-10T12:05:00.000Z");
    expect(
      mistralVibeUsageLimitResetAt("Rate limit hit; retry at 2026-11-10T12:05:00+00:00.", nowMs),
    ).toBe("2026-11-10T12:05:00.000Z");
  });

  it("computes a reset from a retry-after duration", () => {
    expect(mistralVibeUsageLimitResetAt("Retry after 30 seconds.", nowMs)).toBe(
      "2026-11-10T12:00:30.000Z",
    );
    expect(mistralVibeUsageLimitResetAt("Quota available in 5 minutes.", nowMs)).toBe(
      "2026-11-10T12:05:00.000Z",
    );
  });

  it("takes the latest future reset when the text names several", () => {
    expect(
      mistralVibeUsageLimitResetAt(
        "Retry after 30 seconds. Your usage window resets at 2026-11-10T12:05:00Z.",
        nowMs,
      ),
    ).toBe("2026-11-10T12:05:00.000Z");
  });

  it("has no reset without text, or when every named reset already passed", () => {
    expect(mistralVibeUsageLimitResetAt(undefined, nowMs)).toBeNull();
    expect(mistralVibeUsageLimitResetAt("Rate limit exceeded.", nowMs)).toBeNull();
    expect(
      mistralVibeUsageLimitResetAt("Your usage window resets at 2026-11-10T11:59:00Z.", nowMs),
    ).toBeNull();
    expect(mistralVibeUsageLimitResetAt("Retry after 0 seconds.", nowMs)).toBeNull();
  });
});

describe("mistralVibePromptFailure", () => {
  const refusal = (message: string) =>
    new EffectAcpErrors.AcpRequestError({ code: MISTRAL_VIBE_RATE_LIMITED, errorMessage: message });

  it("classifies -31001 as a usage limit and carries the parsed reset", () => {
    const failure = mistralVibePromptFailure(
      refusal("Rate limit exceeded. Your usage window resets at 2026-11-10T12:05:00Z."),
      nowMs,
    );
    expect(failure).toEqual({
      class: "usage_limit",
      message: "Rate limit exceeded. Your usage window resets at 2026-11-10T12:05:00Z.",
      code: "-31001",
      retryable: null,
      resetAt: "2026-11-10T12:05:00.000Z",
    });
  });

  it("omits resetAt when the refusal names no future reset", () => {
    const failure = mistralVibePromptFailure(
      refusal("Rate limit exceeded for mistral (model: mistral-vibe-cli-latest)."),
      nowMs,
    );
    expect(failure).toEqual({
      class: "usage_limit",
      message: "Rate limit exceeded for mistral (model: mistral-vibe-cli-latest).",
      code: "-31001",
      retryable: null,
    });
  });
});
