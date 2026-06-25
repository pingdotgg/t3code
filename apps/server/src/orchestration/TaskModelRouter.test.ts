import {
  type DelegateTaskInput,
  type ModelSelection,
  ProviderInstanceId,
  type TaskRoutingSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveTaskModelSelection } from "./TaskModelRouter.ts";

const sel = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

const parent = sel("codex", "gpt-5.4");

const task = (overrides: Partial<DelegateTaskInput> = {}): DelegateTaskInput => ({
  prompt: "do the thing",
  ...overrides,
});

const routing = (settings: Partial<TaskRoutingSettings>): TaskRoutingSettings => ({
  rules: [],
  ...settings,
});

describe("resolveTaskModelSelection", () => {
  it("uses the explicit per-task modelSelection above everything else", () => {
    const explicit = sel("claudeAgent", "claude-opus-4-8");
    const result = resolveTaskModelSelection(
      task({ modelSelection: explicit, modelHint: "cheap" }),
      {
        parentModelSelection: parent,
        routing: routing({
          rules: [{ when: { modelHint: "cheap" }, use: sel("codex", "gpt-5.4-mini") }],
          default: sel("codex", "gpt-5.4-nano"),
        }),
      },
    );
    expect(result).toEqual(explicit);
  });

  it("routes by the first matching rule (modelHint)", () => {
    const strong = sel("claudeAgent", "claude-opus-4-8");
    const result = resolveTaskModelSelection(task({ modelHint: "strong" }), {
      parentModelSelection: parent,
      routing: routing({
        rules: [
          { when: { modelHint: "cheap" }, use: sel("codex", "gpt-5.4-mini") },
          { when: { modelHint: "strong" }, use: strong },
        ],
      }),
    });
    expect(result).toEqual(strong);
  });

  it("matches a rule by case-insensitive label substring", () => {
    const docsModel = sel("codex", "gpt-5.4-mini");
    const result = resolveTaskModelSelection(task({ label: "Write DOCS for module" }), {
      parentModelSelection: parent,
      routing: routing({ rules: [{ when: { labelMatches: "docs" }, use: docsModel }] }),
    });
    expect(result).toEqual(docsModel);
  });

  it("falls back to routing.default when no rule matches", () => {
    const fallback = sel("codex", "gpt-5.4-nano");
    const result = resolveTaskModelSelection(task({ modelHint: "balanced" }), {
      parentModelSelection: parent,
      routing: routing({
        rules: [{ when: { modelHint: "cheap" }, use: sel("codex", "gpt-5.4-mini") }],
        default: fallback,
      }),
    });
    expect(result).toEqual(fallback);
  });

  it("falls back to the parent model when there is no routing config", () => {
    const result = resolveTaskModelSelection(task(), { parentModelSelection: parent });
    expect(result).toEqual(parent);
  });

  it("skips candidates whose instance is disabled", () => {
    const disabled = sel("brokenInstance", "whatever");
    const result = resolveTaskModelSelection(task({ modelSelection: disabled }), {
      parentModelSelection: parent,
      isInstanceEnabled: (instanceId) => instanceId !== "brokenInstance",
    });
    expect(result).toEqual(parent);
  });
});
