import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  getComposerProviderState,
  getComposerReasoningStep,
  withImplicitFastModeDefault,
} from "./composerProviderState";
import { readPromptUltrathink } from "./TraitsPicker";

const PROVIDER: ProviderDriverKind = ProviderDriverKind.make("codex");
const MODEL = "test-model";

function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  promptInjectedValues?: ReadonlyArray<string>,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  const defaultId = options.find((option) => option.isDefault)?.id;
  return {
    id,
    label: id,
    type: "select",
    options: [...options],
    ...(defaultId ? { currentValue: defaultId } : {}),
    ...(promptInjectedValues && promptInjectedValues.length > 0
      ? { promptInjectedValues: [...promptInjectedValues] }
      : {}),
  };
}

function booleanDescriptor(
  id: string,
  currentValue?: boolean,
): Extract<ProviderOptionDescriptor, { type: "boolean" }> {
  return {
    id,
    label: id,
    type: "boolean",
    ...(typeof currentValue === "boolean" ? { currentValue } : {}),
  };
}

function modelWith(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<ServerProviderModel> {
  return [
    { slug: MODEL, name: MODEL, isCustom: false, capabilities: { optionDescriptors: descriptors } },
  ];
}

function selections(
  ...entries: Array<[string, string | boolean]>
): ReadonlyArray<ProviderOptionSelection> {
  return entries.map(([id, value]) => ({ id, value }));
}

describe("getComposerProviderState", () => {
  it("uses descriptor defaults for display without dispatching them as overrides", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("effort", [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ]),
      ]),
      modelOptions: undefined,
      planModeEnabled: true,
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: "high",
      modelOptionsForDispatch: undefined,
    });
  });

  it("preserves selections that match defaults so deepMerge can overwrite prior state", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("effort", [{ id: "high", label: "High", isDefault: true }]),
        booleanDescriptor("fastMode"),
      ]),
      modelOptions: selections(["effort", "high"], ["fastMode", false]),
      planModeEnabled: true,
    });

    expect(state.modelOptionsForDispatch).toEqual(
      selections(["effort", "high"], ["fastMode", false]),
    );
  });

  it("drops selections for descriptors the model does not declare", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([booleanDescriptor("thinking")]),
      modelOptions: selections(["effort", "max"], ["thinking", false]),
      planModeEnabled: true,
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: null,
      modelOptionsForDispatch: selections(["thinking", false]),
    });
  });

  it("derives promptEffort from the first select descriptor and preserves all others for dispatch", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("effort", [{ id: "high", label: "High", isDefault: true }]),
        selectDescriptor("contextWindow", [
          { id: "200k", label: "200k", isDefault: true },
          { id: "1m", label: "1M" },
        ]),
        selectDescriptor("agent", [
          { id: "build", label: "Build", isDefault: true },
          { id: "plan", label: "Plan" },
        ]),
      ]),
      modelOptions: selections(["agent", "plan"]),
      planModeEnabled: true,
    });

    expect(state.promptEffort).toBe("high");
    expect(state.modelOptionsForDispatch).toEqual(selections(["agent", "plan"]));
  });

  it("drops the plan agent from dispatch when legacy plan mode is disabled", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("agent", [
          { id: "build", label: "Build", isDefault: true },
          { id: "plan", label: "Plan" },
        ]),
      ]),
      modelOptions: selections(["agent", "plan"]),
      planModeEnabled: false,
    });

    expect(state.modelOptionsForDispatch).toEqual(selections(["agent", "build"]));
  });

  it("preserves explicit options when the selected model is absent from the catalog", () => {
    const state = getComposerProviderState({
      provider: ProviderDriverKind.make("opencode"),
      model: "opencode/kimi-k3",
      models: [
        {
          slug: "opencode/big-pickle",
          name: "Big Pickle",
          isCustom: false,
          capabilities: {},
        },
      ],
      modelOptions: selections(["variant", "max"], ["agent", "build"]),
      planModeEnabled: false,
    });

    expect(state.modelOptionsForDispatch).toEqual(
      selections(["variant", "max"], ["agent", "build"]),
    );
  });

  it("validates options for a known model selected through a legacy alias", () => {
    const state = getComposerProviderState({
      provider: ProviderDriverKind.make("claudeAgent"),
      model: "legacy-test-model",
      models: [
        {
          slug: "test-model",
          name: "Test Model",
          aliases: ["legacy-test-model"],
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              selectDescriptor("effort", [
                { id: "low", label: "Low" },
                { id: "high", label: "High", isDefault: true },
              ]),
            ],
          },
        },
      ],
      modelOptions: selections(["effort", "low"], ["unknown", "value"]),
      planModeEnabled: false,
    });

    expect(state.modelOptionsForDispatch).toEqual(selections(["effort", "low"]));
  });

  it("defaults fastMode to false when the provider reports true but the user has not selected it", () => {
    const state = getComposerProviderState({
      provider: ProviderDriverKind.make("cursor"),
      model: MODEL,
      models: modelWith([booleanDescriptor("fastMode", true)]),
      modelOptions: undefined,
      planModeEnabled: true,
    });

    expect(state.modelOptionsForDispatch).toEqual(selections(["fastMode", false]));
  });
});

describe("withImplicitFastModeDefault", () => {
  // regression: #2981 a remembered Fast mode choice must survive the implicit default on new chats
  it("injects fastMode false only when the model exposes fastMode and no selection exists", () => {
    expect(
      withImplicitFastModeDefault(
        {
          optionDescriptors: [booleanDescriptor("fastMode", true)],
        },
        undefined,
      ),
    ).toEqual(selections(["fastMode", false]));

    expect(
      withImplicitFastModeDefault(
        {
          optionDescriptors: [booleanDescriptor("fastMode", true)],
        },
        selections(["fastMode", true]),
      ),
    ).toEqual(selections(["fastMode", true]));
  });
});

describe("readPromptUltrathink", () => {
  it("tells the Ultrathink prefix apart from the word in the body", () => {
    expect(readPromptUltrathink("Fix the bug")).toBe("none");
    expect(readPromptUltrathink("Ultrathink: Fix the bug")).toBe("prefix");
    expect(readPromptUltrathink("ultrathink about the bug")).toBe("body");
    expect(readPromptUltrathink("Ultrathink: ultrathink harder")).toBe("body");
  });
});

describe("getComposerReasoningStep", () => {
  const LEVELS = [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
  ];
  const INSTANCE = ProviderInstanceId.make("codex");
  const CLAUDE = {
    provider: ProviderDriverKind.make("claudeAgent"),
    instanceId: ProviderInstanceId.make("claudeAgent"),
    models: modelWith([
      selectDescriptor(
        "effort",
        [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "ultrathink", label: "Ultrathink" },
        ],
        ["ultrathink"],
      ),
    ]),
  };

  function step(input: Partial<Parameters<typeof getComposerReasoningStep>[0]>) {
    return getComposerReasoningStep({
      provider: PROVIDER,
      instanceId: INSTANCE,
      model: MODEL,
      models: modelWith([selectDescriptor("reasoningEffort", LEVELS)]),
      modelOptions: undefined,
      prompt: "Fix the bug",
      cursor: 0,
      planModeEnabled: true,
      direction: 1,
      ...input,
    });
  }

  it("walks the catalog order, wrapping at both ends and keeping the other traits", () => {
    const models = modelWith([
      selectDescriptor("contextWindow", [
        { id: "200k", label: "200k", isDefault: true },
        { id: "1m", label: "1M" },
      ]),
      selectDescriptor("reasoningEffort", LEVELS),
    ]);
    for (const [from, direction, to] of [
      ["low", -1, "high"],
      ["low", 1, "medium"],
      ["high", 1, "low"],
      ["high", -1, "medium"],
    ] as const) {
      expect(
        step({
          models,
          modelOptions: selections(["contextWindow", "1m"], ["reasoningEffort", from]),
          direction,
        }),
        `${from} by ${direction}`,
      ).toStrictEqual({
        prompt: "Fix the bug",
        cursor: 0,
        modelOptions: selections(["contextWindow", "1m"], ["reasoningEffort", to]),
      });
    }
  });

  it("steps Antigravity's thinking_level like other effort controls", () => {
    expect(
      step({
        provider: ProviderDriverKind.make("antigravity"),
        models: modelWith([selectDescriptor("thinking_level", LEVELS)]),
      })?.modelOptions,
    ).toStrictEqual(selections(["thinking_level", "high"]));
  });

  it("never steps into Ultrathink and strips a typed prefix with the caret on the same character", () => {
    expect(step({ ...CLAUDE, modelOptions: selections(["effort", "high"]) })).toStrictEqual({
      prompt: "Fix the bug",
      cursor: 0,
      modelOptions: selections(["effort", "medium"]),
    });
    const prompt = "Ultrathink:\n  Fix the bug";
    // A typed Ultrathink sits above the pickable levels, so up wraps and down lands on the top level.
    for (const [direction, to] of [
      [-1, "high"],
      [1, "medium"],
    ] as const) {
      const result = step({
        ...CLAUDE,
        prompt,
        cursor: prompt.indexOf("bug"),
        modelOptions: selections(["effort", "medium"]),
        direction,
      });
      expect(result, `by ${direction}`).toStrictEqual({
        prompt: "Fix the bug",
        cursor: 8,
        modelOptions: selections(["effort", to]),
      });
    }
    for (const [prompt, direction] of [
      ["Please ultrathink harder", 1],
      ["Ultrathink:\nPlease ultrathink harder", -1],
    ] as const) {
      expect(
        step({ ...CLAUDE, prompt, modelOptions: selections(["effort", "high"]), direction }),
        prompt,
      ).toBeNull();
    }
  });

  it("keeps a provider-default Fast mode off unless the user chose it", () => {
    const cursor = {
      provider: ProviderDriverKind.make("cursor"),
      instanceId: ProviderInstanceId.make("cursor"),
      models: modelWith([
        selectDescriptor("reasoning_effort", LEVELS),
        booleanDescriptor("fastMode", true),
      ]),
    };

    expect(step({ ...cursor, modelOptions: undefined })?.modelOptions).toStrictEqual(
      selections(["reasoning_effort", "high"], ["fastMode", false]),
    );
    expect(
      step({ ...cursor, modelOptions: selections(["fastMode", true]) })?.modelOptions,
    ).toStrictEqual(selections(["reasoning_effort", "high"], ["fastMode", true]));
  });

  it("steps from the provider-reported level for the same instance and model", () => {
    const reported = {
      instanceId: INSTANCE,
      model: MODEL,
      options: selections(["reasoningEffort", "high"]),
    };
    for (const { label, modelOptions, reportedModelSelection, to } of [
      { label: "reported", modelOptions: undefined, reportedModelSelection: reported, to: "low" },
      {
        label: "other instance",
        modelOptions: undefined,
        reportedModelSelection: { ...reported, instanceId: ProviderInstanceId.make("codex-work") },
        to: "high",
      },
      {
        label: "other model",
        modelOptions: undefined,
        reportedModelSelection: { ...reported, model: "other-model" },
        to: "high",
      },
      {
        label: "explicit draft",
        modelOptions: selections(["reasoningEffort", "low"]),
        reportedModelSelection: reported,
        to: "medium",
      },
      {
        // OpenCode reports "default" when no variant was chosen.
        label: "reported value outside the catalog",
        modelOptions: undefined,
        reportedModelSelection: {
          ...reported,
          options: selections(["reasoningEffort", "default"]),
        },
        to: "high",
      },
    ]) {
      expect(step({ modelOptions, reportedModelSelection })?.modelOptions, label).toStrictEqual(
        selections(["reasoningEffort", to]),
      );
    }
  });
});
