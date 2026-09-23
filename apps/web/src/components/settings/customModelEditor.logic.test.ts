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
    const descriptors = descriptorsFromCapabilities(
      {
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
      },
      ProviderDriverKind.make("claudeAgent"),
    );
    expect(descriptors[0]!.choices.map((choice) => choice.isDefault)).toEqual([false, true]);
    expect(
      definitionFromDraft(draft({ descriptors })).capabilities?.optionDescriptors?.[0],
    ).toMatchObject({ currentValue: "high" });
  });

  it("drops prompt-injected choices when copying a built-in's descriptors", () => {
    const [copied] = descriptorsFromCapabilities(
      {
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
      },
      ProviderDriverKind.make("claudeAgent"),
    );
    expect(copied!.choices.map((choice) => choice.id)).toEqual(["high"]);
  });

  it.each([true, false, undefined])(
    "preserves boolean values through copy and edit: %s",
    (currentValue) => {
      const capabilities: ModelCapabilities = {
        optionDescriptors: [
          {
            id: "thinking",
            label: "Thinking",
            type: "boolean",
            ...(currentValue !== undefined ? { currentValue } : {}),
          },
        ],
      };
      const copied = definitionFromDraft(
        draft({
          descriptors: descriptorsFromCapabilities(capabilities, ProviderDriverKind.make("cursor")),
        }),
      );
      expect(copied.capabilities).toEqual(capabilities);
      const reopened = draftFromDefinition(copied);
      expect(definitionFromDraft({ ...reopened, name: "Renamed" }).capabilities).toEqual(
        capabilities,
      );
    },
  );

  it("excludes Claude context choices from presets and copies without changing other providers or authored entries", () => {
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
    const claude = ProviderDriverKind.make("claudeAgent");
    const copied = definitionFromDraft(
      draft({ descriptors: descriptorsFromCapabilities(capabilities, claude) }),
    );
    expect(copied.capabilities?.optionDescriptors).toEqual([capabilities.optionDescriptors![1]]);
    const presets = definitionFromDraft(
      draft({
        descriptors: (DESCRIPTOR_PRESETS_BY_KIND[claude] ?? []).map(descriptorFromPreset),
      }),
    );
    expect(
      presets.capabilities?.optionDescriptors?.some((option) => option.id === "contextWindow"),
    ).toBe(false);
    const cursorCopy = descriptorsFromCapabilities(capabilities, ProviderDriverKind.make("cursor"));
    expect(cursorCopy.map((option) => option.id)).toEqual(["contextWindow", "thinking"]);
    const authored = { slug: "custom", name: "Custom", capabilities };
    expect(
      definitionFromDraft(draftFromDefinition(authored)).capabilities?.optionDescriptors?.[0],
    ).toMatchObject(capabilities.optionDescriptors![0]!);
  });

  it("preserves choice descriptions when copying, renaming, and saving", () => {
    const capabilities: ModelCapabilities = {
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          description: "Choose a reasoning level.",
          type: "select",
          options: [
            { id: "high", label: "High", isDefault: true },
            { id: "ultracode", label: "Ultracode", description: "Uses additional reasoning." },
          ],
        },
      ],
    };
    const copied = definitionFromDraft(
      draft({
        descriptors: descriptorsFromCapabilities(
          capabilities,
          ProviderDriverKind.make("claudeAgent"),
        ),
      }),
    );
    const reopened = draftFromDefinition(copied);
    const saved = definitionFromDraft({ ...reopened, name: "Renamed" });
    expect(saved.capabilities?.optionDescriptors?.[0]).toMatchObject(
      capabilities.optionDescriptors![0]!,
    );
    expect(copied.capabilities?.optionDescriptors?.[0]).toMatchObject(
      capabilities.optionDescriptors![0]!,
    );
  });

  it.each(Object.entries(DESCRIPTOR_PRESETS_BY_KIND))(
    "offers saveable presets for %s",
    (_driver, presets) => {
      expect(
        validateDraft(draft({ descriptors: (presets ?? []).map(descriptorFromPreset) })),
      ).toBeNull();
    },
  );

  it("collapses a blank name and no options back to a bare definition", () => {
    expect(definitionFromDraft(draft({ name: "  " }))).toEqual({
      slug: "my-model",
      name: "my-model",
      capabilities: null,
    });
    expect(draftFromDefinition({ slug: "x", name: "x", capabilities: null }).name).toBe("");
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
