import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelCapabilities,
  type ProviderOptionSelection,
} from "@t3tools/contracts";

import {
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
  normalizeCustomModelSlug,
  normalizeModelSlug,
  resolveReasoningTransition,
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
  it("applies selection values to capability descriptors", () => {
    expect(
      getProviderOptionDescriptors({
        caps: claudeCaps,
        selections: [
          { id: "effort", value: "medium" },
          { id: "contextWindow", value: "200k" },
        ],
      }),
    ).toEqual([
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "ultrathink", label: "Ultrathink" },
        ],
        currentValue: "medium",
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
        currentValue: "200k",
      },
    ]);
  });

  it("builds wire-format option selections from descriptors", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });

    expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
  });

  it("stores option selection arrays in model selections", () => {
    expect(
      createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("reads typed option selection values", () => {
    const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);

    expect(getProviderOptionStringSelectionValue(selection.options, "reasoningEffort")).toBe(
      "high",
    );
    expect(getProviderOptionStringSelectionValue(selection.options, "fastMode")).toBeUndefined();
    expect(getProviderOptionBooleanSelectionValue(selection.options, "fastMode")).toBe(true);
    expect(
      getProviderOptionBooleanSelectionValue(selection.options, "reasoningEffort"),
    ).toBeUndefined();
    expect(getModelSelectionStringOptionValue(selection, "reasoningEffort")).toBe("high");
    expect(getModelSelectionBooleanOptionValue(selection, "fastMode")).toBe(true);
  });
});

describe("model slug normalization", () => {
  it("preserves exact custom slugs instead of expanding provider aliases", () => {
    const claude = ProviderDriverKind.make("claudeAgent");

    expect(normalizeModelSlug("opus", claude)).toBe("claude-opus-5");
    expect(normalizeCustomModelSlug(" opus ")).toBe("opus");
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
