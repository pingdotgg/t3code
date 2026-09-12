import { expect, it } from "@effect/vitest";
import { devinModels, resolveDevinModel } from "./DevinModels.ts";

const lead = {
  slug: "opus",
  family_label: "Opus",
  variants: [
    { model_uid: "high", label: "Opus High" },
    { model_uid: "medium", label: "Opus Medium" },
    { model_uid: "fast-high", label: "Opus High Fast" },
    { model_uid: "fast-medium", label: "Opus Medium Fast" },
  ],
};
const sidekick = {
  slug: "swe",
  family_label: "SWE",
  variants: [{ model_uid: "native-swe", label: "SWE High" }],
};
const catalog = { families: [lead, sidekick] };

it("groups variants into independent controls, including a single remaining thinking level", () => {
  const models = devinModels(catalog);
  expect(models.map((model) => model.slug)).toEqual(["opus", "swe"]);
  expect(models[0]?.capabilities?.optionDescriptors).toEqual([
    {
      id: "reasoningEffort",
      label: "Thinking level",
      type: "select",
      currentValue: "high",
      options: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
    },
    { id: "fastMode", label: "Fast mode", type: "boolean", currentValue: false },
  ]);
  expect(models[1]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
    currentValue: "high",
    options: [{ id: "high", label: "High" }],
  });
  expect(resolveDevinModel(catalog, { model: "opus" })).toBe("high");
  const reordered = { families: [{ ...lead, variants: lead.variants.toReversed() }] };
  expect(devinModels(reordered)[0]?.capabilities?.optionDescriptors).toEqual([
    { ...models[0]!.capabilities!.optionDescriptors![0], currentValue: "medium" },
    { ...models[0]!.capabilities!.optionDescriptors![1], currentValue: true },
  ]);
  expect(resolveDevinModel(reordered, { model: "opus" })).toBe("fast-medium");
});

it.each([
  { effort: "medium", fast: false, expected: "medium" },
  { effort: "high", fast: true, expected: "fast-high" },
  { effort: "max", fast: false, expected: undefined },
])("resolves only offered thinking/speed choices: $effort, $fast", ({ effort, fast, expected }) => {
  expect(
    resolveDevinModel(catalog, {
      model: "opus",
      options: [
        { id: "reasoningEffort", value: effort },
        { id: "fastMode", value: fast },
      ],
    }),
  ).toBe(expected);
});

it.each(["XHigh", "X-High"])("orders native thinking labels, including %s", (extraHigh) => {
  const suffixes = ["Medium Thinking", "No Thinking", "Max", extraHigh, "High", "Low", "Minimal"];
  const models = devinModels({
    families: [
      {
        slug: "test",
        family_label: "Test",
        variants: suffixes.map((suffix, index) => ({
          model_uid: `native-${index}`,
          label: `Test ${suffix}`,
        })),
      },
    ],
  });
  const thinking = models[0]?.capabilities?.optionDescriptors?.[0];
  expect(thinking?.type === "select" && thinking.options.map((option) => option.id)).toEqual([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

it("maps thinking and context controls to opaque native IDs", () => {
  const contextCatalog = {
    families: [
      {
        slug: "opus",
        family_label: "Opus",
        variants: [
          { model_uid: "NATIVE_A", label: "Opus" },
          { model_uid: "NATIVE_B", label: "Opus Thinking" },
          { model_uid: "NATIVE_C", label: "Opus 1M" },
          { model_uid: "NATIVE_D", label: "Opus Thinking 1M" },
        ],
      },
    ],
  };
  expect(devinModels(contextCatalog)[0]?.capabilities?.optionDescriptors).toMatchObject([
    { id: "reasoningEffort", options: [{ id: "none" }, { id: "thinking" }] },
    { id: "contextWindow", options: [{ id: "standard" }, { id: "1m" }] },
  ]);
  expect(
    resolveDevinModel(contextCatalog, {
      model: "opus",
      options: [
        { id: "reasoningEffort", value: "thinking" },
        { id: "contextWindow", value: "1m" },
      ],
    }),
  ).toBe("NATIVE_D");
  expect(resolveDevinModel(catalog, { model: "custom-id" })).toBe("custom-id");
  expect(resolveDevinModel(catalog, { model: "fast-high" })).toBe("fast-high");
});

it.each([
  { labels: ["Future Special"] },
  { labels: ["Future High", "Future Medium Fast"] },
  { labels: ["Future None", "Future No Thinking"] },
  { labels: ["Fusion (Unknown Lead + Unknown Sidekick)"], fusion: true },
])("preserves exact IDs for unfamiliar or ambiguous families: $labels", ({ labels, fusion }) => {
  const variants = labels.map((label, index) => ({ model_uid: `native-${index}`, label }));
  const catalog = {
    families: [{ slug: fusion ? "fusion" : "future", family_label: "Future", variants }],
  };
  expect(devinModels(catalog).map((model) => [model.slug, model.name])).toEqual(
    variants.map((variant) => [variant.model_uid, variant.label]),
  );
  for (const variant of variants)
    expect(resolveDevinModel(catalog, { model: variant.model_uid })).toBe(variant.model_uid);
});

it("groups Fusion by lead and exact sidekick while keeping the lead's thinking and speed controls", () => {
  const fusionCatalog = {
    families: [
      ...catalog.families,
      {
        slug: "fusion",
        family_label: "Fusion",
        variants: [
          { model_uid: "pair-high", label: "Fusion (Opus High + SWE High)" },
          { model_uid: "pair-medium", label: "Fusion (Opus Medium + SWE High)" },
          { model_uid: "pair-fast-high", label: "Fusion (Opus High Fast + SWE High)" },
          { model_uid: "pair-fast-medium", label: "Fusion (Opus Medium Fast + SWE High)" },
          { model_uid: "pair-other", label: "Fusion (Opus High + Opus Medium)" },
        ],
      },
    ],
  };
  const pairings = devinModels(fusionCatalog).filter((model) => model.fusion);
  expect(pairings.map((model) => model.name)).toEqual([
    "Fusion (Opus + SWE High)",
    "Fusion (Opus + Opus Medium)",
  ]);
  expect(pairings[0]?.fusion).toEqual({
    lead: { id: "opus", name: "Opus" },
    sidekick: { id: "native-swe", name: "SWE High" },
  });
  expect(pairings[0]?.capabilities).toEqual(devinModels(catalog)[0]?.capabilities);
  expect(
    resolveDevinModel(fusionCatalog, {
      model: pairings[0]!.slug,
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    }),
  ).toBe("pair-fast-high");
  expect(resolveDevinModel(fusionCatalog, { model: pairings[1]!.slug })).toBe("pair-other");
});
