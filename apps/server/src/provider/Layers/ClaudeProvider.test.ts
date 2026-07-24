import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import {
  getClaudeModelCapabilities,
  normalizeClaudeCliEffort,
  resolveClaudeApiModelId,
  resolveClaudeContextWindow,
} from "./ClaudeProvider.ts";

const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");

function descriptorIds(model: string): ReadonlyArray<string> {
  const descriptors = getClaudeModelCapabilities(model).optionDescriptors ?? [];
  return descriptors.map((descriptor) => descriptor.id);
}

describe("ClaudeProvider Opus 5", () => {
  it("exposes reasoning, fast mode, and context window on a single model entry", () => {
    expect(descriptorIds("claude-opus-5")).toEqual(["effort", "fastMode", "contextWindow"]);
  });

  it("keeps xhigh as xhigh instead of widening it to max", () => {
    expect(normalizeClaudeCliEffort("xhigh", "claude-opus-5")).toBe("xhigh");
  });

  it("still widens xhigh to max for models that do not support it", () => {
    expect(normalizeClaudeCliEffort("xhigh", "claude-opus-4-6")).toBe("max");
  });

  it("maps ultracode to xhigh and drops the prompt-prefix ultrathink mode", () => {
    expect(normalizeClaudeCliEffort("ultracode", "claude-opus-5")).toBe("xhigh");
    expect(normalizeClaudeCliEffort("ultrathink", "claude-opus-5")).toBeUndefined();
  });

  it("defaults to the 1M context window", () => {
    const selection = createModelSelection(CLAUDE_INSTANCE, "claude-opus-5");
    expect(resolveClaudeContextWindow(selection)).toBe("1m");
    expect(resolveClaudeApiModelId(selection)).toBe("claude-opus-5[1m]");
  });

  it("drops the 1M suffix when the 200k context window is selected", () => {
    const selection = createModelSelection(CLAUDE_INSTANCE, "claude-opus-5", [
      { id: "contextWindow", value: "200k" },
    ]);
    expect(resolveClaudeContextWindow(selection)).toBe("200k");
    expect(resolveClaudeApiModelId(selection)).toBe("claude-opus-5");
  });
});
