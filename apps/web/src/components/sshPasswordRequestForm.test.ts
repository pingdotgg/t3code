import { describe, expect, it } from "@effect/vitest";

import { canSubmitSshPassword, getSshPasswordPromptRemainingMs } from "./sshPasswordRequestForm";

describe("SSH password request form", () => {
  it("starts a fresh prompt countdown from its relative lifetime despite clock skew", () => {
    const receivedAtMs = Date.parse("2026-08-18T12:05:00.000Z");
    const remainingMs = getSshPasswordPromptRemainingMs({
      expiresInMs: 3 * 60 * 1_000,
      receivedAtMs,
      nowMs: receivedAtMs,
    });

    expect(remainingMs).toBe(3 * 60 * 1_000);
    expect(
      canSubmitSshPassword({
        password: "secret",
        isResponding: false,
        isExpired: remainingMs <= 0,
      }),
    ).toBe(true);
  });

  it("requires a non-empty password for an active prompt", () => {
    expect(canSubmitSshPassword({ password: "", isResponding: false, isExpired: false })).toBe(
      false,
    );
    expect(canSubmitSshPassword({ password: "secret", isResponding: true, isExpired: false })).toBe(
      false,
    );
    expect(canSubmitSshPassword({ password: "secret", isResponding: false, isExpired: true })).toBe(
      false,
    );
    expect(
      canSubmitSshPassword({ password: "secret", isResponding: false, isExpired: false }),
    ).toBe(true);
  });
});
