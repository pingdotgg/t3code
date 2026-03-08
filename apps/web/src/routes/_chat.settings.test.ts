import { describe, expect, it } from "vitest";

import { getProviderAuthGuidance } from "../providerAuthGuidance";

describe("getProviderAuthGuidance", () => {
  it("documents Claude Code's native auth modes without app-managed secrets", () => {
    expect(getProviderAuthGuidance("claudeCode")).toEqual({
      summary: "Auth modes: Max/Pro sign-in or Claude-native API key mode.",
      detail:
        "Use `claude auth login` for Max/Pro, or configure API key mode outside T3 Code with `ANTHROPIC_API_KEY`, `apiKeyHelper`, or `forceLoginMethod`. T3 Code does not store Claude secrets.",
    });
  });

  it("does not add extra auth guidance for Codex", () => {
    expect(getProviderAuthGuidance("codex")).toBeNull();
  });
});