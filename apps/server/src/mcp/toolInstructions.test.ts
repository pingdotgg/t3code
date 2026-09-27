import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "../provider/RuntimeInstructions.ts";

describe("t3-code tool instructions", () => {
  it.each(["Claude Code", "Codex", "Cursor", "Grok", "OpenCode", "Antigravity"])(
    "tell %s agents when to use prism_submit and when spawn_thread",
    (harness) => {
      const instructions = buildRuntimeInstructions({ harness });
      expect(instructions).toContain("<t3_code_tool_use>");
      expect(instructions).toContain(
        "For an authorized job that should end in one PR, call prism_submit",
      );
      expect(instructions).toContain(
        "or when a specific model and effort is wanted, call spawn_thread",
      );
    },
  );

  it("keep the Codex runtime entry inside its 1,000-token additional-context cap", () => {
    // Codex cuts the middle of any additionalContext value above 1,000 tokens.
    // Three characters per token is a conservative bound for this English text.
    const instructions = buildRuntimeInstructions({
      harness: "Codex",
      model: "gpt-5.5",
      modelName: "GPT-5.5",
      reasoningEffort: "xhigh",
    });
    expect(instructions.length).toBeLessThan(3_000);
  });
});
