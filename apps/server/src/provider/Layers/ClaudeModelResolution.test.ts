import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { resolveClaudeApiModelId } from "./ClaudeModelResolution.ts";

const claudeInstanceId = ProviderInstanceId.make("claudeAgent");

describe("resolveClaudeApiModelId", () => {
  it("keeps the default Claude Code Bedrock model mapping", () => {
    const selection = createModelSelection(claudeInstanceId, "claude-opus-4-8", [
      { id: "contextWindow", value: "1m" },
    ]);

    expect(resolveClaudeApiModelId(selection)).toBe("us.anthropic.claude-opus-4-8[1m]");
  });

  it("maps built-in Claude models to OpenRouter aliases", () => {
    const selection = createModelSelection(claudeInstanceId, "claude-opus-4-8", [
      { id: "contextWindow", value: "1m" },
    ]);

    expect(
      resolveClaudeApiModelId(selection, { ANTHROPIC_BASE_URL: "https://openrouter.ai/api" }),
    ).toBe("~anthropic/claude-opus-latest");
  });

  it("maps persisted Bedrock model ids to OpenRouter aliases", () => {
    const selection = createModelSelection(claudeInstanceId, "us.anthropic.claude-opus-4-8", []);

    expect(
      resolveClaudeApiModelId(selection, { ANTHROPIC_BASE_URL: "https://openrouter.ai/api" }),
    ).toBe("~anthropic/claude-opus-latest");
  });

  it("keeps explicit OpenRouter aliases unchanged", () => {
    const selection = createModelSelection(claudeInstanceId, "~anthropic/claude-opus-latest", [
      { id: "contextWindow", value: "1m" },
    ]);

    expect(
      resolveClaudeApiModelId(selection, { ANTHROPIC_BASE_URL: "https://openrouter.ai/api" }),
    ).toBe("~anthropic/claude-opus-latest");
  });
});
