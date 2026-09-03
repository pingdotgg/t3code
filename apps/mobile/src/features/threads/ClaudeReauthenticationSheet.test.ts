import { describe, expect, it } from "@effect/vitest";

import { isClaudeAuthenticationError } from "./claudeReauthentication";

describe("isClaudeAuthenticationError", () => {
  it("accepts the session provider identity", () => {
    expect(
      isClaudeAuthenticationError({
        errorClass: "auth_error",
        providerName: "claudeAgent",
      }),
    ).toBe(true);
  });

  it("falls back to the configured provider driver", () => {
    expect(
      isClaudeAuthenticationError({
        errorClass: "auth_error",
        providerDriver: "claudeAgent",
      }),
    ).toBe(true);
  });

  it("does not offer Claude auth for other failures or providers", () => {
    expect(
      isClaudeAuthenticationError({
        errorClass: "provider_error",
        providerName: "claudeAgent",
      }),
    ).toBe(false);
    expect(
      isClaudeAuthenticationError({
        errorClass: "auth_error",
        providerName: "codex",
        providerDriver: "codex",
      }),
    ).toBe(false);
  });
});
