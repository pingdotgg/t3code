import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelCapabilities,
  type ProviderOptionSelection,
} from "@t3tools/contracts";

import {
  applyClaudePromptEffortPrefix,
  buildExplicitProviderOptionSelectionsFromDescriptors,
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  getProviderOptionCurrentLabel,
  getProviderOptionDescriptors,
  readCustomModelEntries,
  normalizeCustomModelSlug,
  normalizeModelSlug,
  resolveReasoningTransition,
  modelSelectionsEqual,
} from "./model.ts";

const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "xhigh", label: "Extra High" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

const claudeCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      currentValue: "high",
      promptInjectedValues: ["ultrathink"],
    },
    {
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [
        { id: "200k", label: "200k" },
        { id: "1m", label: "1M", isDefault: true },
      ],
      currentValue: "1m",
    },
  ],
});

describe("descriptor helpers", () => {
  it("builds dispatch options only from explicit selections", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [{ id: "fastMode", value: true }],
    });

    expect(buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, undefined)).toBe(
      undefined,
    );
    expect(
      buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, [
        { id: "fastMode", value: true },
      ]),
    ).toEqual([{ id: "fastMode", value: true }]);
  });

  it("dispatches an old Ultracode effort as Extra High with the Ultracode toggle", () => {
    const legacy = [{ id: "effort", value: "ultracode" }];
    const descriptors = getProviderOptionDescriptors({
      caps: createModelCapabilities({
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "high", label: "High", isDefault: true },
              { id: "xhigh", label: "Extra High" },
            ],
          },
          { id: "ultracode", label: "Ultracode", type: "boolean" },
        ],
      }),
      selections: legacy,
    });

    expect(buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, legacy)).toEqual([
      { id: "effort", value: "xhigh" },
      { id: "ultracode", value: true },
    ]);
  });

  it("compares complete model selections independent of option ordering", () => {
    const left = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
    const reordered = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "fastMode", value: true },
      { id: "reasoningEffort", value: "high" },
    ]);

    expect(modelSelectionsEqual(left, reordered)).toBe(true);
    expect(
      modelSelectionsEqual(left, {
        ...reordered,
        options: [
          { id: "fastMode", value: true },
          { id: "reasoningEffort", value: "medium" },
        ],
      }),
    ).toBe(false);
    expect(modelSelectionsEqual(left, { ...reordered, model: "gpt-5.5" })).toBe(false);
  });
});

describe("model slug normalization", () => {
  it("preserves exact custom slugs instead of expanding provider aliases", () => {
    const claude = ProviderDriverKind.make("claudeAgent");

    // Claude slugs resolve through the model catalog now, so the driver-level
    // alias table no longer expands Claude nicknames.
    expect(normalizeModelSlug("opus", claude)).toBe("opus");
    expect(normalizeCustomModelSlug(" opus ")).toBe("opus");
  });

  it("expands Cursor nicknames onto current ACP model ids", () => {
    const cursor = ProviderDriverKind.make("cursor");
    expect(normalizeModelSlug("composer", cursor)).toBe("composer-2");
    expect(normalizeModelSlug("opus", cursor)).toBe("claude-opus-5");
    expect(normalizeModelSlug("sonnet-5", cursor)).toBe("claude-sonnet-5");
    expect(normalizeModelSlug("gpt-5.4", cursor)).toBe("gpt-5.4");
  });
});

function transition(input: {
  capabilities?: ModelCapabilities;
  modelOptions?: ReadonlyArray<ProviderOptionSelection>;
  prompt?: string;
  action?:
    | { type: "cycle"; direction: "increase" | "decrease" }
    | { type: "select"; descriptorId: string; value: string };
}) {
  return resolveReasoningTransition({
    capabilities: input.capabilities ?? codexCaps,
    modelOptions: input.modelOptions,
    prompt: input.prompt ?? "",
    action: input.action ?? { type: "cycle", direction: "increase" },
  });
}

describe("resolveReasoningTransition", () => {
  it("cycles Codex in advertised order in both directions with wraparound", () => {
    expect(transition({ modelOptions: [{ id: "reasoningEffort", value: "xhigh" }] })).toEqual({
      status: "changed",
      prompt: "",
      modelOptions: [{ id: "reasoningEffort", value: "high" }],
      value: "high",
      label: "High",
    });
    expect(
      transition({
        modelOptions: [{ id: "reasoningEffort", value: "high" }],
        action: { type: "cycle", direction: "decrease" },
      }),
    ).toEqual({
      status: "changed",
      prompt: "",
      modelOptions: [{ id: "reasoningEffort", value: "xhigh" }],
      value: "xhigh",
      label: "Extra High",
    });
  });

  it("never strips an Ultrathink prefix from providers that do not own it", () => {
    expect(
      transition({
        modelOptions: [{ id: "reasoningEffort", value: "high" }],
        prompt: "Ultrathink:\nthis is user text",
      }),
    ).toEqual(
      expect.objectContaining({
        prompt: "Ultrathink:\nthis is user text",
        value: "xhigh",
      }),
    );
  });

  it("supports Cursor's normalized reasoning descriptor", () => {
    const cursorCaps = createModelCapabilities({
      optionDescriptors: [
        {
          id: "reasoning",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "off", label: "Off" },
            { id: "on", label: "On" },
          ],
          currentValue: "off",
        },
      ],
    });

    expect(transition({ capabilities: cursorCaps })).toEqual(
      expect.objectContaining({
        status: "changed",
        modelOptions: [{ id: "reasoning", value: "on" }],
        value: "on",
      }),
    );
    expect(
      transition({
        capabilities: cursorCaps,
        modelOptions: [{ id: "reasoning", value: "off" }],
        action: { type: "cycle", direction: "decrease" },
      }),
    ).toEqual(expect.objectContaining({ value: "on" }));
  });

  it("resolves explicit, default, and missing current values", () => {
    expect(transition({ modelOptions: [{ id: "reasoningEffort", value: "xhigh" }] })).toEqual(
      expect.objectContaining({ value: "high" }),
    );
    expect(transition({})).toEqual(expect.objectContaining({ value: "xhigh" }));

    const unresolvedCaps = createModelCapabilities({
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        },
      ],
    });
    expect(transition({ capabilities: unresolvedCaps })).toEqual(
      expect.objectContaining({ value: "low" }),
    );
    expect(
      transition({
        capabilities: unresolvedCaps,
        action: { type: "cycle", direction: "decrease" },
      }),
    ).toEqual(expect.objectContaining({ value: "high" }));
  });

  it("cycles Claude ordinary effort and ultrathink without persisting prompt values", () => {
    expect(
      transition({
        capabilities: claudeCaps,
        modelOptions: [{ id: "effort", value: "medium" }],
      }),
    ).toEqual(
      expect.objectContaining({
        prompt: "",
        modelOptions: [{ id: "effort", value: "high" }],
        value: "high",
      }),
    );
    expect(
      transition({
        capabilities: claudeCaps,
        modelOptions: [{ id: "effort", value: "high" }],
        prompt: "keep this exactly",
      }),
    ).toEqual({
      status: "changed",
      prompt: "Ultrathink:\nkeep this exactly",
      modelOptions: [{ id: "effort", value: "high" }],
      value: "ultrathink",
      label: "Ultrathink",
    });
    expect(
      transition({
        capabilities: claudeCaps,
        modelOptions: [{ id: "effort", value: "high" }],
        prompt: "Ultrathink:\nkeep this exactly",
      }),
    ).toEqual({
      status: "changed",
      prompt: "keep this exactly",
      modelOptions: [{ id: "effort", value: "medium" }],
      value: "medium",
      label: "Medium",
    });
  });

  it("supports Claude's persisted ultracode option as an ordinary effort", () => {
    const caps = createModelCapabilities({
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "high", label: "High" },
            { id: "ultracode", label: "Ultracode" },
            { id: "ultrathink", label: "Ultrathink" },
          ],
          currentValue: "high",
          promptInjectedValues: ["ultrathink"],
        },
      ],
    });

    expect(
      transition({ capabilities: caps, modelOptions: [{ id: "effort", value: "high" }] }),
    ).toEqual(
      expect.objectContaining({
        modelOptions: [{ id: "effort", value: "ultracode" }],
        value: "ultracode",
      }),
    );
  });

  it("enters ultrathink from empty prompts and strips only its owned leading prefix", () => {
    expect(
      transition({
        capabilities: claudeCaps,
        modelOptions: [{ id: "effort", value: "high" }],
      }),
    ).toEqual(expect.objectContaining({ prompt: "Ultrathink:\n", value: "ultrathink" }));
    expect(
      transition({
        capabilities: claudeCaps,
        prompt: "ultrathink:\r\n\n  preserved body  ",
        action: { type: "select", descriptorId: "effort", value: "medium" },
      }),
    ).toEqual(expect.objectContaining({ prompt: "\n  preserved body  " }));
  });

  it("blocks leaving ultrathink when it occurs in the prompt body", () => {
    const modelOptions = [{ id: "effort", value: "high" }] as const;
    expect(
      transition({
        capabilities: claudeCaps,
        modelOptions,
        prompt: "Explain ultrathink without changing my text",
        action: { type: "select", descriptorId: "effort", value: "medium" },
      }),
    ).toEqual({ status: "blocked", reason: "ultrathink-in-prompt-body" });
    expect(
      transition({
        capabilities: claudeCaps,
        modelOptions,
        prompt: "Explain ultrathink without changing my text",
        action: { type: "select", descriptorId: "effort", value: "ultrathink" },
      }),
    ).toEqual({ status: "unchanged" });
    expect(modelOptions).toEqual([{ id: "effort", value: "high" }]);
  });

  it("removes stale prompt-injected values from persisted selections", () => {
    expect(
      transition({
        capabilities: claudeCaps,
        modelOptions: [{ id: "effort", value: "ultrathink" }],
        prompt: "Ultrathink:\nkeep this",
        action: { type: "select", descriptorId: "effort", value: "high" },
      }),
    ).toEqual(
      expect.objectContaining({
        prompt: "keep this",
        modelOptions: [{ id: "effort", value: "high" }],
      }),
    );
  });

  it("does not persist unknown future prompt-injected values", () => {
    const capabilities = createModelCapabilities({
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "high", label: "High" },
            { id: "future-injected", label: "Future" },
          ],
          currentValue: "high",
          promptInjectedValues: ["future-injected"],
        },
      ],
    });

    expect(transition({ capabilities, prompt: "keep this" })).toEqual({
      status: "unsupported",
      reason: "unsupported-prompt-injected-value",
    });
  });

  it("preserves unrelated and unknown selections in their original order", () => {
    const modelOptions = [
      { id: "future", value: "unchanged" },
      { id: "effort", value: "medium" },
      { id: "thinking", value: true },
      { id: "contextWindow", value: "200k" },
    ] as const;
    const result = transition({ capabilities: claudeCaps, modelOptions });

    expect(result).toEqual(
      expect.objectContaining({
        modelOptions: [
          { id: "future", value: "unchanged" },
          { id: "effort", value: "high" },
          { id: "thinking", value: true },
          { id: "contextWindow", value: "200k" },
        ],
      }),
    );
    expect(modelOptions).toEqual([
      { id: "future", value: "unchanged" },
      { id: "effort", value: "medium" },
      { id: "thinking", value: true },
      { id: "contextWindow", value: "200k" },
    ]);
  });

  it("does not infer OpenCode variants or models without reasoning capabilities", () => {
    const openCodeCaps = createModelCapabilities({
      optionDescriptors: [
        {
          id: "variant",
          label: "Variant",
          type: "select",
          options: [{ id: "fast", label: "Fast" }],
        },
      ],
    });
    expect(transition({ capabilities: openCodeCaps })).toEqual({
      status: "unsupported",
      reason: "missing-reasoning-option",
    });
    expect(
      transition({ capabilities: createModelCapabilities({ optionDescriptors: [] }) }),
    ).toEqual({ status: "unsupported", reason: "missing-reasoning-option" });
  });

  it("handles no choices, one choice, and stale direct selections", () => {
    const emptyCaps = createModelCapabilities({
      optionDescriptors: [{ id: "reasoning", label: "Reasoning", type: "select", options: [] }],
    });
    expect(transition({ capabilities: emptyCaps })).toEqual({
      status: "unsupported",
      reason: "missing-choices",
    });

    const oneChoiceCaps = createModelCapabilities({
      optionDescriptors: [
        {
          id: "reasoning",
          label: "Reasoning",
          type: "select",
          options: [{ id: "on", label: "On", isDefault: true }],
        },
      ],
    });
    expect(transition({ capabilities: oneChoiceCaps })).toEqual({ status: "unchanged" });
    expect(
      transition({
        capabilities: oneChoiceCaps,
        action: { type: "select", descriptorId: "reasoning", value: "missing" },
      }),
    ).toEqual({ status: "invalid", reason: "unknown-value" });
  });

  it("makes direct selection and cycling to the same target identical", () => {
    const modelOptions = [{ id: "reasoningEffort", value: "xhigh" }] as const;
    const cycled = transition({ modelOptions });
    const selected = transition({
      modelOptions,
      action: { type: "select", descriptorId: "reasoningEffort", value: "high" },
    });
    expect(selected).toEqual(cycled);
  });

  it("returns not-applicable for non-reasoning mouse selections", () => {
    expect(
      transition({
        capabilities: claudeCaps,
        action: { type: "select", descriptorId: "contextWindow", value: "200k" },
      }),
    ).toEqual({ status: "not-applicable" });
  });
});

describe("applyClaudePromptEffortPrefix", () => {
  it("keeps slash commands intact when ultrathink is selected", () => {
    expect(applyClaudePromptEffortPrefix("/compact", "ultrathink")).toBe("/compact");
    expect(applyClaudePromptEffortPrefix(" /compact keep recent errors ", "ultrathink")).toBe(
      "/compact keep recent errors",
    );
    expect(applyClaudePromptEffortPrefix(" /review src/model.ts ", "ultrathink")).toBe(
      "/review src/model.ts",
    );
    expect(applyClaudePromptEffortPrefix("/security-review", "ultrathink")).toBe(
      "/security-review",
    );
    expect(applyClaudePromptEffortPrefix("/plugin:skill run", "ultrathink")).toBe(
      "/plugin:skill run",
    );
    expect(applyClaudePromptEffortPrefix("/deploy.prod to staging", "ultrathink")).toBe(
      "/deploy.prod to staging",
    );
  });

  it("still adds the ultrathink prefix to ordinary prompts", () => {
    expect(applyClaudePromptEffortPrefix("Investigate this failure", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate this failure",
    );
    expect(applyClaudePromptEffortPrefix("/home/theo/app.ts crashed on load", "ultrathink")).toBe(
      "Ultrathink:\n/home/theo/app.ts crashed on load",
    );
  });
});

describe("applyClaudePromptEffortPrefix", () => {
  it("keeps slash commands intact when ultrathink is selected", () => {
    expect(applyClaudePromptEffortPrefix("/compact", "ultrathink")).toBe("/compact");
    expect(applyClaudePromptEffortPrefix(" /compact keep recent errors ", "ultrathink")).toBe(
      "/compact keep recent errors",
    );
    expect(applyClaudePromptEffortPrefix(" /review src/model.ts ", "ultrathink")).toBe(
      "/review src/model.ts",
    );
    expect(applyClaudePromptEffortPrefix("/security-review", "ultrathink")).toBe(
      "/security-review",
    );
    expect(applyClaudePromptEffortPrefix("/plugin:skill run", "ultrathink")).toBe(
      "/plugin:skill run",
    );
    expect(applyClaudePromptEffortPrefix("/deploy.prod to staging", "ultrathink")).toBe(
      "/deploy.prod to staging",
    );
  });

  it("still adds the ultrathink prefix to ordinary prompts", () => {
    expect(applyClaudePromptEffortPrefix("Investigate this failure", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate this failure",
    );
    expect(applyClaudePromptEffortPrefix("/home/theo/app.ts crashed on load", "ultrathink")).toBe(
      "Ultrathink:\n/home/theo/app.ts crashed on load",
    );
  });
});

describe("readCustomModelEntries", () => {
  const capabilities: ModelCapabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
        currentValue: "high",
      },
    ],
  };

  it("resolves bare slugs and entries, trimming and deduplicating on slug", () => {
    expect(
      readCustomModelEntries([
        " bare ",
        { slug: "named", name: " Named ", capabilities },
        "bare",
        { slug: "named", name: "Second" },
        "",
        { name: "no slug" },
        42,
      ]),
    ).toEqual([
      { slug: "bare", name: "bare", capabilities: null },
      { slug: "named", name: "Named", capabilities },
    ]);
  });

  it("drops unparseable capabilities but keeps the entry", () => {
    expect(
      readCustomModelEntries([{ slug: "x", capabilities: { optionDescriptors: "nope" } }]),
    ).toEqual([{ slug: "x", name: "x", capabilities: null }]);
    expect(readCustomModelEntries("not a list")).toEqual([]);
  });
});

describe("provider-reported option display", () => {
  const selection = createModelSelection(ProviderInstanceId.make("opencode"), "ling");
  const reported = { ...selection, options: [{ id: "variant", value: "default" }] };
  const descriptor = {
    id: "variant",
    label: "Reasoning",
    type: "select" as const,
    options: [
      { id: "none", label: "None" },
      { id: "thinking", label: "Thinking" },
    ],
  };

  it("shows explicit reports without adding a choice or a dispatch option", () => {
    expect(getProviderOptionCurrentLabel(descriptor, selection, reported)).toBe("Default");
    expect(
      getProviderOptionCurrentLabel(descriptor, selection, {
        ...reported,
        options: [{ id: "variant", value: "thinking" }],
      }),
    ).toBe("Thinking");
    expect(
      getProviderOptionCurrentLabel(
        { ...descriptor, currentValue: "none" },
        { ...selection, options: [{ id: "variant", value: "none" }] },
        reported,
      ),
    ).toBe("None");
    expect(descriptor.options.map((option) => option.id)).toEqual(["none", "thinking"]);
    expect(buildProviderOptionSelectionsFromDescriptors([descriptor])).toBeUndefined();
    expect(getProviderOptionCurrentLabel(descriptor, selection)).toBe("Unknown");
    const effortDescriptor = { ...descriptor, id: "effort", currentValue: "default" };
    expect(getProviderOptionCurrentLabel(effortDescriptor, selection)).toBeUndefined();
    expect(
      getProviderOptionCurrentLabel(effortDescriptor, selection, {
        ...reported,
        model: "other",
        options: [{ id: "effort", value: "default" }],
      }),
    ).toBeUndefined();
    expect(
      getProviderOptionCurrentLabel(effortDescriptor, selection, {
        ...reported,
        options: [{ id: "effort", value: "default" }],
      }),
    ).toBe("Default");
    expect(
      getProviderOptionCurrentLabel({ ...descriptor, currentValue: "thinking" }, selection),
    ).toBe("Unknown");
  });

  it.each([
    { ...selection, model: "other" },
    { ...selection, instanceId: ProviderInstanceId.make("other") },
    { ...selection, options: [{ id: "variant", value: "none" }] },
  ])("ignores reports after changing the model, instance, or option: %j", (selected) => {
    expect(getProviderOptionCurrentLabel(descriptor, selected, reported)).toBe("Unknown");
  });
});
