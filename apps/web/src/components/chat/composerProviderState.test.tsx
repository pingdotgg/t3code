import { describe, expect, it } from "vitest";
import {
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  getComposerProviderState,
  renderProviderReasoningPicker,
  renderProviderTraitsMenuContent,
  renderProviderTraitsMenuContentWithoutReasoning,
  renderProviderTraitsPicker,
} from "./composerProviderState";
import { shouldRenderTraitsControls } from "./TraitsPicker";
import { DraftId } from "../../composerDraftStore";

// Everything in composerProviderState is now data-driven by the model's
// optionDescriptors, so these tests use a single synthetic provider/model and
// vary only the descriptor shape per scenario.

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

function booleanDescriptor(id: string): Extract<ProviderOptionDescriptor, { type: "boolean" }> {
  return { id, label: id, type: "boolean" };
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

const ULTRATHINK_FRAME_CLASSES = {
  composerFrameClassName: "ultrathink-frame",
  composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.04)_inset]",
  modelPickerIconClassName: "ultrathink-chroma",
} as const;

describe("getComposerProviderState", () => {
  it("returns descriptor defaults when no selections are provided", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("effort", [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ]),
      ]),
      prompt: "",
      modelOptions: undefined,
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: "high",
      modelOptionsForDispatch: selections(["effort", "high"]),
    });
  });

  it("lets selections override defaults and propagates them through dispatch", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("effort", [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ]),
        booleanDescriptor("fastMode"),
      ]),
      prompt: "",
      modelOptions: selections(["effort", "low"], ["fastMode", true]),
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: "low",
      modelOptionsForDispatch: selections(["effort", "low"], ["fastMode", true]),
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
      prompt: "",
      modelOptions: selections(["effort", "high"], ["fastMode", false]),
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
      prompt: "",
      modelOptions: selections(["effort", "max"], ["thinking", false]),
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
      prompt: "",
      modelOptions: selections(["agent", "plan"]),
    });

    expect(state.promptEffort).toBe("high");
    expect(state.modelOptionsForDispatch).toEqual(
      selections(["effort", "high"], ["contextWindow", "200k"], ["agent", "plan"]),
    );
  });

  it("returns undefined dispatch options when the model declares no descriptors", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([]),
      prompt: "",
      modelOptions: selections(["anything", "value"]),
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: null,
      modelOptionsForDispatch: undefined,
    });
  });

  it("keeps Codex Auto Review in dispatch options without making it a traits control", () => {
    const models = modelWith([
      { id: "autoReview", label: "Auto Review", type: "boolean", currentValue: false },
    ]);
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models,
      prompt: "",
      modelOptions: undefined,
    });

    expect(state.modelOptionsForDispatch).toEqual(selections(["autoReview", false]));
    expect(
      shouldRenderTraitsControls({
        provider: PROVIDER,
        model: MODEL,
        models,
        prompt: "",
        modelOptions: state.modelOptionsForDispatch,
      }),
    ).toBe(false);
  });

  it("adds ultrathink class names when the prompt triggers a promptInjectedValues descriptor", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
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
      prompt: "Ultrathink:\nInvestigate this failure",
      modelOptions: selections(["effort", "medium"]),
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: "medium",
      modelOptionsForDispatch: selections(["effort", "medium"]),
      ...ULTRATHINK_FRAME_CLASSES,
    });
  });

  it("does not add ultrathink class names when the descriptor has no promptInjectedValues", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("effort", [{ id: "high", label: "High", isDefault: true }]),
      ]),
      prompt: "Ultrathink:\nInvestigate this failure",
      modelOptions: undefined,
    });

    expect(state).not.toHaveProperty("composerFrameClassName");
    expect(state).not.toHaveProperty("composerSurfaceClassName");
    expect(state).not.toHaveProperty("modelPickerIconClassName");
  });
});

describe("provider traits render guards", () => {
  it("returns null when no thread target is provided", () => {
    const models = modelWith([
      selectDescriptor("effort", [{ id: "high", label: "High", isDefault: true }]),
    ]);
    const args = {
      provider: PROVIDER,
      model: MODEL,
      models,
      modelOptions: undefined,
      prompt: "",
      onPromptChange: () => {},
    };

    expect(renderProviderTraitsPicker(args)).toBeNull();
    expect(renderProviderTraitsMenuContent(args)).toBeNull();
  });
});

describe("compact reasoning split", () => {
  const DRAFT_ID = DraftId.make("draft-reasoning-split");

  function argsFor(descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
    return {
      provider: PROVIDER,
      model: MODEL,
      models: modelWith(descriptors),
      modelOptions: undefined,
      prompt: "",
      onPromptChange: () => {},
      draftId: DRAFT_ID,
    };
  }

  it("renders a reasoning picker only when the model exposes a reasoning control", () => {
    const reasoning = selectDescriptor("reasoningEffort", [
      { id: "low", label: "Low" },
      { id: "high", label: "High", isDefault: true },
    ]);

    expect(renderProviderReasoningPicker(argsFor([reasoning]))).not.toBeNull();
    expect(renderProviderReasoningPicker(argsFor([booleanDescriptor("fastMode")]))).toBeNull();
  });

  it("excludes reasoning from the compact more-controls menu", () => {
    const reasoning = selectDescriptor("reasoningEffort", [
      { id: "low", label: "Low" },
      { id: "high", label: "High", isDefault: true },
    ]);

    // Reasoning-only model: the more-controls traits section collapses to null.
    expect(renderProviderTraitsMenuContentWithoutReasoning(argsFor([reasoning]))).toBeNull();
    // With another trait present, the menu renders (and that trait is reasoning's sibling).
    expect(
      renderProviderTraitsMenuContentWithoutReasoning(
        argsFor([reasoning, booleanDescriptor("fastMode")]),
      ),
    ).not.toBeNull();
  });
});
