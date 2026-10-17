import { describe, expect, it } from "@effect/vitest";

import { acpRegistryPromptUsageSemantics } from "./adapter.ts";

describe("acpRegistryPromptUsageSemantics", () => {
  it("declares per-turn usage for the live-probed GLM agent", () => {
    expect(acpRegistryPromptUsageSemantics("glm-acp-agent")).toBe("per_turn");
  });

  it("leaves every other agent undeclared until probed live", () => {
    // Kimi CLI 1.52.0 returns no PromptResponse.usage at all; Grok
    // (grok-build), Antigravity (antigravity-acp), and the rest are unprobed.
    for (const agentId of [
      "kimi",
      "grok-build",
      "antigravity-acp",
      "devin",
      "github-copilot-cli",
      "mistral-vibe",
      "claude-acp",
      "gemini",
      "",
    ]) {
      expect(acpRegistryPromptUsageSemantics(agentId)).toBeUndefined();
    }
  });
});
