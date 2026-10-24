import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ModelCapabilities } from "@t3tools/contracts";

import {
  DESCRIPTOR_PRESETS_BY_KIND,
  descriptorFromPreset,
  definitionFromDraft,
  descriptorsFromCapabilities,
  draftFromDefinition,
  validateDraft,
  type CustomModelDraft,
} from "./customModelEditor.logic";

const draft = (overrides: Partial<CustomModelDraft>): CustomModelDraft => ({
  slug: "my-model",
  name: "",
  descriptors: [],
  ...overrides,
});

describe("customModelEditor.logic", () => {
  it("round-trips a definition through the draft, marking the current value as default", () => {
    const definition = definitionFromDraft(
      draft({
        name: " My Model ",
        descriptors: [
          {
            key: "a",
            type: "select",
            id: "reasoningEffort",
            label: "Reasoning",
            choices: [
              { key: "a1", id: "low", label: "Low", isDefault: false },
              { key: "a2", id: "high", label: "", isDefault: true },
            ],
          },
          { key: "b", type: "boolean", id: "fastMode", label: "Fast Mode", choices: [] },
        ],
      }),
    );

    expect(definition).toEqual({
      slug: "my-model",
      name: "My Model",
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "high", isDefault: true },
            ],
            currentValue: "high",
          },
          { id: "fastMode", label: "Fast Mode", type: "boolean" },
        ],
      },
    });

    const reopened = draftFromDefinition(definition);
    expect(reopened.name).toBe("My Model");
    expect(reopened.descriptors.map((descriptor) => descriptor.id)).toEqual([
      "reasoningEffort",
      "fastMode",
    ]);
    expect(reopened.descriptors[0]!.choices.map((choice) => choice.isDefault)).toEqual([
      false,
      true,
    ]);
  });

  it("preserves the current choice when it differs from the built-in default", () => {
    const descriptors = descriptorsFromCapabilities({
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          currentValue: "high",
          options: [
            { id: "low", label: "Low", isDefault: true },
            { id: "high", label: "High" },
          ],
        },
      ],
    });
    expect(descriptors[0]!.choices.map((choice) => choice.isDefault)).toEqual([false, true]);
    expect(
      definitionFromDraft(draft({ descriptors })).capabilities?.optionDescriptors?.[0],
    ).toMatchObject({ currentValue: "high" });
  });

  it("drops prompt-injected choices when copying a built-in's descriptors", () => {
    const [copied] = descriptorsFromCapabilities({
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "high", label: "High", isDefault: true },
            { id: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        },
      ],
    });
    expect(copied!.choices.map((choice) => choice.id)).toEqual(["high"]);
  });

  it("keeps Claude context choices in presets and copies", () => {
    const capabilities: ModelCapabilities = {
      optionDescriptors: [
        {
          id: "contextWindow",
          label: "Context",
          type: "select",
          options: [{ id: "1m", label: "1M", isDefault: true }],
        },
        { id: "thinking", label: "Thinking", type: "boolean", currentValue: true },
      ],
    };
    const copied = definitionFromDraft(
      draft({ descriptors: descriptorsFromCapabilities(capabilities) }),
    );
    expect(copied.capabilities?.optionDescriptors).toEqual([
      { ...capabilities.optionDescriptors![0], currentValue: "1m" },
      capabilities.optionDescriptors![1],
    ]);
    const presets = definitionFromDraft(
      draft({
        descriptors: (DESCRIPTOR_PRESETS_BY_KIND[ProviderDriverKind.make("claudeAgent")] ?? []).map(
          descriptorFromPreset,
        ),
      }),
    );
    expect(
      presets.capabilities?.optionDescriptors?.find((option) => option.id === "contextWindow"),
    ).toMatchObject({
      options: [
        { id: "200k", isDefault: true },
        { id: "1m", label: "1M" },
      ],
    });
  });

  it("rejects duplicate ids, blank ids, and selects without choices", () => {
    const select = (id: string, choices: Array<{ id: string }>) => ({
      key: id,
      type: "select" as const,
      id,
      label: "Label",
      choices: choices.map((choice) => ({
        key: choice.id,
        label: "",
        isDefault: false,
        ...choice,
      })),
    });

    expect(validateDraft(draft({ descriptors: [select("", [{ id: "a" }])] }))).toBe(
      "Option 1 needs an id.",
    );
    expect(
      validateDraft(
        draft({ descriptors: [select("effort", [{ id: "a" }]), select("effort", [{ id: "b" }])] }),
      ),
    ).toBe('Option 2: id "effort" is used twice.');
    expect(validateDraft(draft({ descriptors: [select("effort", [])] }))).toBe(
      "Option 1 needs at least one choice.",
    );
    expect(
      validateDraft(draft({ descriptors: [select("effort", [{ id: "a" }, { id: "a" }])] })),
    ).toBe('Option 1: choice "a" is used twice.');
    expect(validateDraft(draft({ descriptors: [select("effort", [{ id: "a" }])] }))).toBeNull();
  });
});
