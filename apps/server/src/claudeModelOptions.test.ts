import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import { compileClaudeModelSelection } from "./claudeModelOptions.ts";
import {
  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
  SYNTHETIC_CLAUDE_MODEL_CATALOG,
} from "./provider/ClaudeModelCatalog.testFixtures.ts";

const selection = (
  model: string,
  options: NonNullable<ModelSelection["options"]>,
): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claude_test"),
  model,
  options,
});

describe("compileClaudeModelSelection", () => {
  it.each([
    ["200k", "1"],
    ["1m", "0"],
  ])("compiles the %s context window environment", (window, expected) => {
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-4-6", [{ id: "contextWindow", value: window }]),
      ).env,
    ).toEqual({ CLAUDE_CODE_DISABLE_1M_CONTEXT: expected });
  });

  it("leaves the environment unset for a model without a context selector", () => {
    expect(compileClaudeModelSelection(selection("claude-haiku-4-5", [])).env).toBeUndefined();
  });

  it("changes query identity when switching between 200k and 1m", () => {
    const standard = compileClaudeModelSelection(
      selection("claude-opus-4-6", [{ id: "contextWindow", value: "200k" }]),
    );
    const expanded = compileClaudeModelSelection(
      selection("claude-opus-4-6", [{ id: "contextWindow", value: "1m" }]),
    );
    expect(standard.queryIdentity).not.toBe(expanded.queryIdentity);
  });

  it("changes query identity for context windows even when the API model id is unchanged", () => {
    const catalog = {
      models: SYNTHETIC_CLAUDE_MODEL_CATALOG.models.map((entry) => ({
        ...entry,
        runtime: { ...entry.runtime, modelSuffixes: {} },
      })),
    };
    const standard = compileClaudeModelSelection(
      selection(SYNTHETIC_CLAUDE_CAPABLE_MODEL, [{ id: "contextWindow", value: "standard" }]),
      catalog,
    );
    const expanded = compileClaudeModelSelection(
      selection(SYNTHETIC_CLAUDE_CAPABLE_MODEL, [{ id: "contextWindow", value: "expanded" }]),
      catalog,
    );
    expect(standard.apiModelId).toBe(expanded.apiModelId);
    expect(standard.queryIdentity).not.toBe(expanded.queryIdentity);
  });

  it("compiles context, effort, and settings together", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-fable-5", [
          { id: "contextWindow", value: "1m" },
          { id: "effort", value: "ultracode" },
        ]),
      ),
    ).toMatchObject({
      apiModelId: "claude-fable-5[1m]",
      effort: "xhigh",
      settings: { ultracode: true },
    });
  });

  it("compiles fast mode only for models that expose it", () => {
    expect(
      compileClaudeModelSelection(selection("claude-opus-4-6", [{ id: "fastMode", value: true }]))
        .settings,
    ).toEqual({ fastMode: true });
    expect(
      compileClaudeModelSelection(selection("claude-opus-4-6", [{ id: "fastMode", value: false }]))
        .settings,
    ).toEqual({ fastMode: false });
  });

  it("uses the model default SDK effort alongside prompt-injected effort", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-sonnet-4-6", [{ id: "effort", value: "ultrathink" }]),
      ),
    ).toMatchObject({ effort: "high", promptEffort: "ultrathink" });
  });

  it("compiles the thinking toggle for models that expose it", () => {
    expect(
      compileClaudeModelSelection(selection("claude-haiku-4-5", [{ id: "thinking", value: false }]))
        .settings,
    ).toEqual({ alwaysThinkingEnabled: false });
  });
});
