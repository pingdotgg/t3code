import { describe, expect, it } from "@effect/vitest";

import { getSshPasswordPromptTiming } from "./sshPasswordPromptTiming";

const receivedAtMs = Date.parse("2026-08-17T10:05:00.000Z");
const expiresInMs = 3 * 60 * 1_000;

describe("mobile SSH password prompt timing", () => {
  it("formats the remaining prompt time", () => {
    expect(getSshPasswordPromptTiming(expiresInMs, receivedAtMs, receivedAtMs + 89_750)).toEqual({
      isExpired: false,
      remainingLabel: "1:31",
      remainingSeconds: 91,
    });
  });

  it("reports an expired prompt", () => {
    expect(
      getSshPasswordPromptTiming(expiresInMs, receivedAtMs, receivedAtMs + expiresInMs),
    ).toEqual({
      isExpired: true,
      remainingLabel: "0:00",
      remainingSeconds: 0,
    });
  });

  it("starts a fresh countdown from the relative lifetime despite clock skew", () => {
    expect(getSshPasswordPromptTiming(expiresInMs, receivedAtMs, receivedAtMs)).toEqual({
      isExpired: false,
      remainingLabel: "3:00",
      remainingSeconds: 180,
    });
  });
});
