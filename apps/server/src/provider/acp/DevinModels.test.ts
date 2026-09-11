import { expect, it } from "@effect/vitest";
import { buildProviderOptionSelectionsFromDescriptors } from "@t3tools/shared/model";
import { devinModels, resolveDevinModel } from "./DevinModels.ts";

const catalog = {
  families: [
    {
      slug: "swe-2",
      family_label: "SWE-2",
      variants: [
        { model_uid: "swe-2-high", label: "SWE-2 High" },
        { model_uid: "swe-2-medium", label: "SWE-2 Medium" },
        { model_uid: "swe-2-max", label: "SWE-2 Max" },
      ],
    },
    {
      slug: "swe-1.7",
      family_label: "SWE-1.7",
      variants: [
        { model_uid: "swe-1-7", label: "SWE-1.7 Max" },
        { model_uid: "swe-1-7-medium", label: "SWE-1.7 Medium" },
      ],
    },
    {
      slug: "claude-opus-5",
      family_label: "Claude Opus 5",
      variants: [
        { model_uid: "claude-opus-5-medium", label: "Claude Opus 5 Medium" },
        { model_uid: "claude-opus-5-high", label: "Claude Opus 5 High" },
        { model_uid: "claude-opus-5-medium-fast", label: "Claude Opus 5 Medium Fast" },
        { model_uid: "claude-opus-5-high-fast", label: "Claude Opus 5 High Fast" },
      ],
    },
    {
      slug: "claude-opus-4.6",
      family_label: "Claude Opus 4.6",
      variants: [
        { model_uid: "MODEL_CLAUDE_4_6_OPUS", label: "Claude Opus 4.6" },
        { model_uid: "MODEL_CLAUDE_4_6_OPUS_THINKING", label: "Claude Opus 4.6 Thinking" },
        { model_uid: "MODEL_CLAUDE_4_6_OPUS_1M", label: "Claude Opus 4.6 1M" },
        { model_uid: "MODEL_CLAUDE_4_6_OPUS_THINKING_1M", label: "Claude Opus 4.6 Thinking 1M" },
      ],
    },
  ],
};

it("orders family thinking choices from lowest to highest and keeps the CLI's initial choice", () => {
  const models = devinModels(catalog);
  expect(models.map((model) => model.name)).toEqual([
    "SWE-2",
    "SWE-1.7",
    "Claude Opus 5",
    "Claude Opus 4.6",
  ]);
  expect(models[0]?.capabilities?.optionDescriptors).toEqual([
    {
      id: "reasoningEffort",
      label: "Thinking level",
      type: "select",
      currentValue: "high",
      options: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "max", label: "Max" },
      ],
    },
  ]);
  expect(resolveDevinModel(catalog, { model: "swe-2" })).toBe("swe-2-high");
  expect(
    resolveDevinModel(catalog, {
      model: "swe-2",
      options: [{ id: "reasoningEffort", value: "max" }],
    }),
  ).toBe("swe-2-max");
  expect(
    resolveDevinModel(catalog, {
      model: "swe-1.7",
      options: [{ id: "reasoningEffort", value: "max" }],
    }),
  ).toBe("swe-1-7");
});

it.each([
  {
    family: "GPT-5.6 Sol",
    suffixes: [
      "Medium Thinking",
      "No Thinking",
      "Max Thinking",
      "XHigh Thinking",
      "High Thinking",
      "Low Thinking",
    ],
    expected: ["None", "Low", "Medium", "High", "XHigh", "Max"],
  },
  {
    family: "Gemini 3 Flash",
    suffixes: ["High", "Low", "Minimal", "Medium"],
    expected: ["Minimal", "Low", "Medium", "High"],
  },
  {
    family: "GLM-5.2",
    suffixes: ["High", "Max", "No Thinking"],
    expected: ["None", "High", "Max"],
  },
  {
    family: "Inkling",
    suffixes: ["X-High", "Max", "None", "Medium", "High", "Low"],
    expected: ["None", "Low", "Medium", "High", "XHigh", "Max"],
  },
])(
  "orders $family thinking labels independently of the CLI's order",
  ({ family, suffixes, expected }) => {
    const models = devinModels({
      families: [
        {
          slug: family,
          family_label: family,
          variants: suffixes.map((suffix, index) => ({
            model_uid: `native-${index}`,
            label: `${family} ${suffix}`,
          })),
        },
      ],
    });
    const thinking = models[0]?.capabilities?.optionDescriptors?.find(
      (option) => option.id === "reasoningEffort",
    );
    expect(thinking?.type === "select" && thinking.options.map((option) => option.label)).toEqual(
      expected,
    );
  },
);

it.each(catalog.families)(
  "keeps $slug menus stable when the CLI changes its default variant",
  (family) => {
    const original = devinModels({ families: [family] })[0];
    const choices = (model: typeof original) =>
      model?.capabilities?.optionDescriptors?.map((descriptor) =>
        descriptor.type === "select"
          ? { id: descriptor.id, options: descriptor.options }
          : { id: descriptor.id },
      );
    for (let offset = 1; offset < family.variants.length; offset++) {
      const variants = [...family.variants.slice(offset), ...family.variants.slice(0, offset)];
      const reorderedCatalog = { families: [{ ...family, variants }] };
      const reordered = devinModels(reorderedCatalog)[0];
      expect(choices(reordered)).toEqual(choices(original));
      const options =
        buildProviderOptionSelectionsFromDescriptors(reordered?.capabilities?.optionDescriptors) ??
        [];
      expect(resolveDevinModel(reorderedCatalog, { model: family.slug, options })).toBe(
        variants[0]?.model_uid,
      );
    }
  },
);

it("exposes every catalog variant through independent thinking, speed, and context controls", () => {
  for (const model of devinModels(catalog)) {
    const descriptors = model.capabilities?.optionDescriptors ?? [];
    const combinations = descriptors.reduce<Array<Array<{ id: string; value: string | boolean }>>>(
      (selections, descriptor) =>
        selections.flatMap((selection) =>
          (descriptor.type === "boolean"
            ? [false, true]
            : descriptor.options.map((option) => option.id)
          ).map((value) => [...selection, { id: descriptor.id, value }]),
        ),
      [[]],
    );
    const resolved = combinations.map((options) =>
      resolveDevinModel(catalog, { model: model.slug, options }),
    );
    expect(resolved.toSorted()).toEqual(
      catalog.families
        .find((family) => family.slug === model.slug)
        ?.variants.map((variant) => variant.model_uid)
        .toSorted(),
    );
  }
  expect(
    resolveDevinModel(catalog, {
      model: "claude-opus-5",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    }),
  ).toBe("claude-opus-5-high-fast");
});

it("rejects unavailable combinations and preserves exact custom IDs and unfamiliar variants", () => {
  expect(
    resolveDevinModel(catalog, {
      model: "swe-2",
      options: [{ id: "reasoningEffort", value: "low" }],
    }),
  ).toBeUndefined();
  expect(
    resolveDevinModel(catalog, { model: "swe-2", options: [{ id: "fastMode", value: true }] }),
  ).toBeUndefined();
  expect(resolveDevinModel(catalog, { model: "swe-2-medium" })).toBe("swe-2-medium");
  expect(resolveDevinModel(catalog, { model: "custom-model" })).toBe("custom-model");
  expect(
    devinModels({
      families: [
        {
          slug: "future",
          family_label: "Future",
          variants: [{ model_uid: "future-special", label: "Future Special" }],
        },
      ],
    }).map((model) => model.slug),
  ).toEqual(["future-special"]);
});

it.each(
  [
    [{ model_uid: "future", label: "Future Special" }],
    [
      { model_uid: "future-high", label: "Future High" },
      { model_uid: "future-medium-fast", label: "Future Medium Fast" },
    ],
    [
      { model_uid: "future-none", label: "Future None" },
      { model_uid: "future-no-thinking", label: "Future No Thinking" },
    ],
  ].map((variants) => ({ variants })),
)("keeps ambiguous or incomplete families selectable by exact ID: %j", ({ variants }) => {
  const catalog = { families: [{ slug: "future", family_label: "Future", variants }] };
  const models = devinModels(catalog);
  expect(models.map((model) => model.slug)).toEqual(variants.map((variant) => variant.model_uid));
  for (const model of models)
    expect(resolveDevinModel(catalog, { model: model.slug })).toBe(model.slug);
});

it("keeps the remaining thinking level selectable after an account catalog contracts", () => {
  const models = devinModels({
    families: [
      {
        slug: "swe-2",
        family_label: "SWE-2",
        variants: [{ model_uid: "swe-2-high", label: "SWE-2 High" }],
      },
    ],
  });
  expect(models[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
    id: "reasoningEffort",
    currentValue: "high",
    options: [{ id: "high", label: "High" }],
  });
});
