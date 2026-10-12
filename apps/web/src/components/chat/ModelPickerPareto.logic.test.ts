import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelBenchmarkVariant,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { benchmarkFamily, matchBenchmarkVariants, paretoFrontier } from "./ModelPickerPareto.logic";

const effortModel = (slug: string, efforts: string[], defaultEffort?: string) =>
  ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: efforts.map((id) => ({
            id,
            label: id.toUpperCase(),
            ...(id === defaultEffort ? { isDefault: true } : {}),
          })),
        },
      ],
    },
  }) satisfies ServerProviderModel;

const provider = (
  instanceId: string,
  models: ServerProviderModel[],
  status: ServerProvider["status"] = "ready",
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status,
  auth: { status: "authenticated" },
  checkedAt: "2026-10-07T00:00:00.000Z",
  models,
  slashCommands: [],
  skills: [],
});

const variant = (
  model: string,
  effort: string,
  intelligence: number,
  costPerTask: number,
): ModelBenchmarkVariant => ({ model, effort, intelligence, costPerTask });

const summarize = (points: ReturnType<typeof matchBenchmarkVariants>) =>
  points.map((point) => [
    point.entry.instanceId,
    point.model.slug,
    point.options[0]?.value ?? null,
  ]);

describe("benchmarkFamily", () => {
  it("drops gateway prefixes and turns dots into dashes", () => {
    expect(benchmarkFamily("gpt-6.1-sol")).toBe("gpt-6-1-sol");
    expect(benchmarkFamily("openrouter/anthropic/Claude-Opus-5.5")).toBe("claude-opus-5-5");
  });
});

describe("matchBenchmarkVariants", () => {
  it("maps named and default efforts onto the model's effort choices", () => {
    const entries = deriveProviderInstanceEntries([
      provider("codex", [effortModel("gpt-9.1", ["low", "high", "max"], "high")]),
    ]);
    const points = matchBenchmarkVariants(entries, [
      variant("gpt-9-1", "low", 30, 0.1),
      variant("gpt-9-1", "high", 40, 0.3),
      // Same choice as the named `high` variant, so it is not a second point.
      variant("gpt-9-1", "default", 40, 0.3),
      // The model offers no `xhigh` choice to select.
      variant("gpt-9-1", "xhigh", 45, 0.6),
      variant("other-model", "high", 50, 0.2),
    ]);
    expect(summarize(points)).toEqual([
      ["codex", "gpt-9.1", "low"],
      ["codex", "gpt-9.1", "high"],
    ]);
    expect(points[0]?.options).toEqual([{ id: "reasoningEffort", value: "low" }]);
    expect(points[0]?.effortLabel).toBe("LOW");
  });

  it("selects the default choice, or no option for models without effort", () => {
    const entries = deriveProviderInstanceEntries([
      provider("codex", [
        effortModel("gpt-9.1", ["low", "high"], "high"),
        { slug: "plain-model", name: "Plain", isCustom: false, capabilities: null },
      ]),
    ]);
    const points = matchBenchmarkVariants(entries, [
      variant("gpt-9-1", "default", 40, 0.3),
      variant("plain-model", "default", 20, 0.05),
      variant("plain-model", "high", 25, 0.1),
    ]);
    expect(summarize(points)).toEqual([
      ["codex", "gpt-9.1", "high"],
      ["codex", "plain-model", null],
    ]);
    expect(points[1]?.effortLabel).toBe("Default");
  });

  it("matches aliases and skips unready instances and legacy models", () => {
    const entries = deriveProviderInstanceEntries([
      provider("codex", [
        { ...effortModel("gpt-9.1-preview", ["high"]), aliases: ["gpt-9.1"] },
        { ...effortModel("gpt-8", ["high"]), isLegacy: true },
      ]),
      provider("codex_work", [effortModel("gpt-9.1", ["high"])], "error"),
    ]);
    const points = matchBenchmarkVariants(entries, [
      variant("gpt-9-1", "high", 40, 0.3),
      variant("gpt-8", "high", 30, 0.2),
    ]);
    expect(summarize(points)).toEqual([["codex", "gpt-9.1-preview", "high"]]);
  });

  it("matches models whose id carries the effort, without an option", () => {
    const plain = (slug: string) => ({ slug, name: slug, isCustom: false, capabilities: null });
    const entries = deriveProviderInstanceEntries([
      provider("antigravity", [plain("gem-2.0-flash-high"), plain("gem-2.0-flash-turbo")]),
    ]);
    const points = matchBenchmarkVariants(entries, [variant("gem-2-0-flash", "high", 40, 1.2)]);
    expect(summarize(points)).toEqual([["antigravity", "gem-2.0-flash-high", null]]);
    expect(points[0]?.intelligence).toBe(40);
  });
});

describe("paretoFrontier", () => {
  it("keeps each point smarter than every cheaper one, cheapest first", () => {
    const points = [
      { id: "expensive-dumb", costPerTask: 2, intelligence: 30 },
      { id: "top", costPerTask: 1.5, intelligence: 55 },
      { id: "cheap", costPerTask: 0.01, intelligence: 20 },
      { id: "tie-loser", costPerTask: 0.2, intelligence: 35 },
      { id: "tie-winner", costPerTask: 0.2, intelligence: 40 },
      { id: "equal-not-better", costPerTask: 0.5, intelligence: 40 },
    ];
    expect(paretoFrontier(points).map((point) => point.id)).toEqual(["cheap", "tie-winner", "top"]);
  });

  it("keeps the first of identical points", () => {
    const points = [
      { id: "first", costPerTask: 0.3, intelligence: 40 },
      { id: "second", costPerTask: 0.3, intelligence: 40 },
    ];
    expect(paretoFrontier(points).map((point) => point.id)).toEqual(["first"]);
  });
});
