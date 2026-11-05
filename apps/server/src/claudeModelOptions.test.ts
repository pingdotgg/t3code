import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import { compileClaudeModelSelection } from "./claudeModelOptions.ts";

const selection = (
  model: string,
  options: NonNullable<ModelSelection["options"]>,
): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claude_test"),
  model,
  options,
});

describe("compileClaudeModelSelection", () => {
  it("compiles context, effort, and settings together", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-4-6", [
          { id: "contextWindow", value: "1m" },
          { id: "effort", value: "max" },
          { id: "fastMode", value: true },
        ]),
      ),
    ).toMatchObject({
      apiModelId: "claude-opus-4-6[1m]",
      effort: "max",
      settings: { fastMode: true },
    });
  });

  it("uses the model default SDK effort alongside prompt-injected effort", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-sonnet-4-6", [{ id: "effort", value: "ultrathink" }]),
      ),
    ).toMatchObject({ effort: "high", promptEffort: "ultrathink" });
  });

  it("ignores thinking for catalog models without a thinking option", () => {
    expect(
      compileClaudeModelSelection(selection("claude-opus-5-5", [{ id: "thinking", value: false }]))
        .settings,
    ).not.toHaveProperty("alwaysThinkingEnabled");
  });

  it.each(["gateway-route", "gateway-route[1m]"])(
    "keeps explicit effort and thinking for %s outside the local catalog",
    (model) => {
      for (const thinking of [true, false]) {
        expect(
          compileClaudeModelSelection(
            selection(model, [
              { id: "effort", value: "max" },
              { id: "thinking", value: thinking },
            ]),
          ),
        ).toMatchObject({
          apiModelId: model,
          effort: "max",
          settings: { alwaysThinkingEnabled: thinking },
        });
      }
      const unconfigured = compileClaudeModelSelection(selection(model, []));
      expect(unconfigured.effort).toBeUndefined();
      expect(unconfigured.settings).toEqual({});
    },
  );
});
