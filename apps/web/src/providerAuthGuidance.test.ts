import { describe, expect, it } from "vitest";

import { getProviderAuthGuidance } from "./providerAuthGuidance";

describe("getProviderAuthGuidance", () => {
  it("returns concise Claude auth guidance", () => {
    expect(getProviderAuthGuidance("claudeCode")).toEqual({
      summary: "Claude supports native sign-in and external API-key mode.",
      detail:
        "T3 Code does not store Claude secrets. Use `claude auth login`, or configure API-key mode with environment/config outside the app.",
    });
  });

  it("returns sign-in guidance for unauthenticated Claude", () => {
    expect(getProviderAuthGuidance("claudeCode", "unauthenticated")?.summary).toContain(
      "claude auth login",
    );
  });

  it("does not add extra auth guidance for Codex", () => {
    expect(getProviderAuthGuidance("codex")).toBeNull();
  });
});
