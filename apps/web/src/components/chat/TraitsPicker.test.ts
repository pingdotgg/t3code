import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import {
  buildTraitsTriggerAccessibleLabel,
  buildTraitsTriggerDisplay,
  buildUnavailableModelOptionDescriptors,
  getDaybreakTriggerSelection,
  shouldRenderTraitsControls,
} from "./TraitsPicker";

function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  currentValue: string,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return { id, label: id, type: "select", options: [...options], currentValue };
}

function fastModeDescriptor(
  currentValue: boolean,
): Extract<ProviderOptionDescriptor, { type: "boolean" }> {
  return { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue };
}

function serviceTierDescriptor(
  currentValue: "default" | "priority" | "flex",
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    options: [
      { id: "default", label: "Standard", isDefault: true },
      { id: "priority", label: "Fast" },
      { id: "flex", label: "Flex" },
    ],
    currentValue,
  };
}

const EFFORT = selectDescriptor(
  "reasoningEffort",
  [
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ],
  "high",
);
const CONTEXT_WINDOW = selectDescriptor(
  "contextWindow",
  [
    { id: "200k", label: "200k" },
    { id: "1m", label: "1M" },
  ],
  "1m",
);

const CODEX = ProviderDriverKind.make("codex");

it("keeps the traits control available when Daybreak is a model's only option", () => {
  expect(
    shouldRenderTraitsControls({
      provider: CODEX,
      models: [
        {
          slug: "daybreak-only",
          name: "Daybreak only",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              selectDescriptor(
                "cyberAccessProgram",
                [
                  { id: "standard", label: "Off" },
                  { id: "daybreakBlue", label: "On" },
                ],
                "standard",
              ),
            ],
          },
        },
      ],
      model: "daybreak-only",
      prompt: "",
      modelOptions: null,
      planModeEnabled: false,
    }),
  ).toBe(true);
});

function display(descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
  return buildTraitsTriggerDisplay({
    provider: CODEX,
    descriptors,
    primarySelectDescriptorId: "reasoningEffort",
    ultrathinkPromptControlled: false,
  });
}

describe("buildTraitsTriggerDisplay", () => {
  it("omits fast mode from the label entirely when it is off", () => {
    expect(display([EFFORT, fastModeDescriptor(false), CONTEXT_WINDOW])).toEqual({
      label: "High · 1M",
      showFastModeIcon: false,
    });
  });

  it("shows the bolt instead of a text label when fast mode is on", () => {
    expect(display([EFFORT, fastModeDescriptor(true), CONTEXT_WINDOW])).toEqual({
      label: "High · 1M",
      showFastModeIcon: true,
    });
  });

  it("treats Codex standard and fast service tiers as fast mode states", () => {
    expect(display([EFFORT, serviceTierDescriptor("default")])).toEqual({
      label: "High",
      showFastModeIcon: false,
    });
    expect(display([EFFORT, serviceTierDescriptor("priority")])).toEqual({
      label: "High",
      showFastModeIcon: true,
    });
  });

  it("keeps other Codex service tiers in the label", () => {
    expect(display([EFFORT, serviceTierDescriptor("flex")])).toEqual({
      label: "High · Flex",
      showFastModeIcon: false,
    });
  });

  it("keeps the Codex service tier readable when it is the only trait", () => {
    expect(display([serviceTierDescriptor("default")])).toEqual({
      label: "Standard",
      showFastModeIcon: false,
    });
    expect(display([serviceTierDescriptor("priority")])).toEqual({
      label: "Fast",
      showFastModeIcon: false,
    });
  });

  it("keeps Daybreak out of the visible label and announces each available state", () => {
    const daybreak = selectDescriptor(
      "cyberAccessProgram",
      [
        { id: "standard", label: "Off", isDefault: true },
        { id: "daybreakRed", label: "Red" },
        { id: "daybreakBlue", label: "Blue" },
      ],
      "standard",
    );
    for (const [program, announcement] of [
      ["standard", "Daybreak Off"],
      ["daybreakBlue", "Daybreak Blue"],
      ["daybreakRed", "Daybreak Red"],
    ] as const) {
      const descriptors = [EFFORT, { ...daybreak, currentValue: program }];
      const trigger = display(descriptors);
      expect(trigger.label).toBe("High");
      expect(getDaybreakTriggerSelection(CODEX, descriptors)?.hasBothPrograms).toBe(true);
      expect(
        buildTraitsTriggerAccessibleLabel(trigger, getDaybreakTriggerSelection(CODEX, descriptors)),
      ).toBe(`High, ${announcement}`);
    }
  });

  it("labels Daybreak when it is the only trait", () => {
    const daybreak = selectDescriptor(
      "cyberAccessProgram",
      [
        { id: "standard", label: "Off", isDefault: true },
        { id: "daybreakBlue", label: "On" },
      ],
      "standard",
    );
    expect(display([daybreak])).toEqual({ label: "Daybreak Off", showFastModeIcon: false });
    expect(
      buildTraitsTriggerAccessibleLabel(
        display([daybreak]),
        getDaybreakTriggerSelection(CODEX, [daybreak]),
      ),
    ).toBe("Daybreak Off");
    expect(display([{ ...daybreak, currentValue: "daybreakBlue" }])).toEqual({
      label: "Daybreak On",
      showFastModeIcon: false,
    });
  });

  it.each([
    ["standard", "Daybreak Off"],
    ["daybreakBlue", "Daybreak Blue"],
    ["daybreakRed", "Daybreak Red"],
    ["futureProgram", "Daybreak futureProgram"],
  ])("preserves the label for a saved %s selection missing from the model", (value, label) => {
    const descriptors = [selectDescriptor("cyberAccessProgram", [], value)];
    const trigger = display(descriptors);
    expect(trigger).toEqual({ label, showFastModeIcon: false });
    expect(
      buildTraitsTriggerAccessibleLabel(trigger, getDaybreakTriggerSelection(CODEX, descriptors)),
    ).toBe(label);

    const combinedDescriptors = [EFFORT, serviceTierDescriptor("priority"), ...descriptors];
    const combinedTrigger = display(combinedDescriptors);
    expect(combinedTrigger).toEqual({ label: "High", showFastModeIcon: true });
    const selection = getDaybreakTriggerSelection(CODEX, combinedDescriptors);
    expect(selection?.program).toBe(value === "futureProgram" ? null : value);
    expect(buildTraitsTriggerAccessibleLabel(combinedTrigger, selection)).toBe(
      `High, Fast mode on, ${label}`,
    );
  });

  it.each(["default", "priority"] as const)(
    "shows Daybreak alongside the %s service tier when they are the only traits",
    (tier) => {
      const descriptors = [
        serviceTierDescriptor(tier),
        selectDescriptor(
          "cyberAccessProgram",
          [
            { id: "standard", label: "Off" },
            { id: "daybreakBlue", label: "On" },
          ],
          "daybreakBlue",
        ),
      ];
      const trigger = display(descriptors);
      expect(trigger).toEqual({ label: "Daybreak On", showFastModeIcon: tier === "priority" });
      expect(
        buildTraitsTriggerAccessibleLabel(trigger, getDaybreakTriggerSelection(CODEX, descriptors)),
      ).toBe(tier === "priority" ? "Daybreak On, Fast mode on" : "Daybreak On");
    },
  );

  it("omits the Daybreak announcement when the model has no Daybreak descriptor", () => {
    const trigger = display([EFFORT, serviceTierDescriptor("priority")]);
    expect(
      getDaybreakTriggerSelection(CODEX, [EFFORT, serviceTierDescriptor("priority")]),
    ).toBeNull();
    expect(buildTraitsTriggerAccessibleLabel(trigger, null)).toBe("High, Fast mode on");
  });

  it("announces Fast mode and Daybreak together while keeping reasoning as the visible text", () => {
    const descriptors = [
      EFFORT,
      serviceTierDescriptor("priority"),
      selectDescriptor(
        "cyberAccessProgram",
        [
          { id: "standard", label: "Off", isDefault: true },
          { id: "daybreakBlue", label: "On" },
        ],
        "daybreakBlue",
      ),
    ];
    const trigger = display(descriptors);
    expect(trigger).toEqual({ label: "High", showFastModeIcon: true });
    expect(getDaybreakTriggerSelection(CODEX, descriptors)?.hasBothPrograms).toBe(false);
    expect(
      buildTraitsTriggerAccessibleLabel(trigger, getDaybreakTriggerSelection(CODEX, descriptors)),
    ).toBe("High, Fast mode on, Daybreak On");
  });

  it("announces On for an account with only Daybreak Red", () => {
    const descriptors = [
      EFFORT,
      selectDescriptor(
        "cyberAccessProgram",
        [
          { id: "standard", label: "Off", isDefault: true },
          { id: "daybreakRed", label: "On" },
        ],
        "daybreakRed",
      ),
    ];
    const selection = getDaybreakTriggerSelection(CODEX, descriptors);
    expect(selection).toEqual({ program: "daybreakRed", label: "On", hasBothPrograms: false });
    expect(buildTraitsTriggerAccessibleLabel(display(descriptors), selection)).toBe(
      "High, Daybreak On",
    );
  });

  it("keeps non-fastMode booleans as text labels", () => {
    const thinking: Extract<ProviderOptionDescriptor, { type: "boolean" }> = {
      id: "thinking",
      label: "Thinking",
      type: "boolean",
      currentValue: true,
    };
    expect(display([EFFORT, thinking])).toEqual({
      label: "High · Thinking On",
      showFastModeIcon: false,
    });
  });

  it("falls back to a text label when fast mode is the only trait", () => {
    expect(display([fastModeDescriptor(true)])).toEqual({
      label: "Fast",
      showFastModeIcon: false,
    });
    expect(display([fastModeDescriptor(false)])).toEqual({
      label: "Normal",
      showFastModeIcon: false,
    });
  });

  it("stays blank when descriptors resolve to no label and there is no fast mode", () => {
    // A select with neither a currentValue nor an isDefault option yields no
    // label. Without a fastMode descriptor present that must stay blank rather
    // than falling through to a bogus "Normal".
    const unresolved: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: "effort",
      label: "effort",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    };
    expect(display([unresolved])).toEqual({ label: "", showFastModeIcon: false });
  });

  it("still renders the prompt-controlled ultrathink label alongside the bolt", () => {
    expect(
      buildTraitsTriggerDisplay({
        provider: CODEX,
        descriptors: [EFFORT, fastModeDescriptor(true)],
        primarySelectDescriptorId: "reasoningEffort",
        ultrathinkPromptControlled: true,
      }),
    ).toEqual({ label: "Ultrathink", showFastModeIcon: true });
  });
});

describe("buildUnavailableModelOptionDescriptors", () => {
  it("shows only saved values without inventing alternatives", () => {
    expect(
      buildUnavailableModelOptionDescriptors([
        { id: "variant", value: "max" },
        { id: "agent", value: "build" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual([
      {
        id: "variant",
        label: "Reasoning",
        type: "select",
        options: [{ id: "max", label: "max" }],
        currentValue: "max",
      },
      {
        id: "agent",
        label: "Agent",
        type: "select",
        options: [{ id: "build", label: "build" }],
        currentValue: "build",
      },
      {
        id: "fastMode",
        label: "Fast Mode",
        type: "boolean",
        currentValue: true,
      },
    ]);
  });
});
