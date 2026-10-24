import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import { compileClaudeModelSelection } from "./claudeModelOptions.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  scopeClaudeModelCatalog,
} from "./provider/ClaudeModelCatalog.ts";

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

  it("keeps explicit effort for models missing from the local catalog", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-pool-model-not-in-catalog", [{ id: "effort", value: "max" }]),
      ).effort,
    ).toBe("max");
    expect(
      compileClaudeModelSelection(selection("claude-pool-model-not-in-catalog", [])).effort,
    ).toBeUndefined();
  });

  it("defaults custom models to thinking on and 200k, with a reversible 1M choice", () => {
    const catalog = scopeClaudeModelCatalog(BUNDLED_CLAUDE_MODEL_CATALOG, ["glm-flash"]);
    for (const options of [[], [{ id: "contextWindow", value: "200k" }]]) {
      expect(compileClaudeModelSelection(selection("glm-flash", options), catalog)).toMatchObject({
        apiModelId: "glm-flash",
        effort: "high",
        settings: { alwaysThinkingEnabled: true },
      });
    }
    expect(
      compileClaudeModelSelection(
        selection("glm-flash", [{ id: "contextWindow", value: "1m" }]),
        catalog,
      ),
    ).toMatchObject({
      apiModelId: "glm-flash[1m]",
      settings: { alwaysThinkingEnabled: true },
    });
  });

  it("compiles 1M, effort, and thinking for a bare custom model", () => {
    const catalog = scopeClaudeModelCatalog(BUNDLED_CLAUDE_MODEL_CATALOG, ["glm-flash"]);
    expect(
      compileClaudeModelSelection(
        selection("glm-flash", [
          { id: "contextWindow", value: "1m" },
          { id: "effort", value: "max" },
          { id: "thinking", value: false },
        ]),
        catalog,
      ),
    ).toMatchObject({
      apiModelId: "glm-flash[1m]",
      effort: "max",
      settings: { alwaysThinkingEnabled: false },
    });
  });
});
