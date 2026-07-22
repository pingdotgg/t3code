import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  getComposerPromptInjectionState,
  getComposerProviderState,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
  resolveModelOptionsShortcutTarget,
  toggleCompactControlsMenuForShortcut,
} from "./composerProviderState";

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
  composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.07)_inset]",
  modelPickerIconClassName: "ultrathink-chroma",
} as const;

describe("resolveModelOptionsShortcutTarget", () => {
  const available = {
    isComposerUnavailable: false,
    compactTraitsAvailable: true,
    expandedTraitsAvailable: true,
  };

  it("opens the layout-specific model options control", () => {
    expect(resolveModelOptionsShortcutTarget({ ...available, isCompact: true })).toBe(
      "compact-controls-menu",
    );
    expect(resolveModelOptionsShortcutTarget({ ...available, isCompact: false })).toBe(
      "traits-picker",
    );
  });

  it("does not open the generic compact menu when model options are unavailable", () => {
    expect(
      resolveModelOptionsShortcutTarget({
        ...available,
        isCompact: true,
        compactTraitsAvailable: false,
      }),
    ).toBeNull();
  });

  it("rejects the shortcut while the composer controls are unavailable", () => {
    expect(
      resolveModelOptionsShortcutTarget({
        ...available,
        isCompact: false,
        isComposerUnavailable: true,
      }),
    ).toBeNull();
  });
});

describe("toggleCompactControlsMenuForShortcut", () => {
  it("keeps the shared menu open when switching shortcut targets", () => {
    expect(toggleCompactControlsMenuForShortcut("model-options", "runtime-mode")).toBe(
      "runtime-mode",
    );
    expect(toggleCompactControlsMenuForShortcut("runtime-mode", "model-options")).toBe(
      "model-options",
    );
  });

  it("closes the shared menu when the same shortcut is repeated", () => {
    expect(toggleCompactControlsMenuForShortcut("model-options", "model-options")).toBeNull();
    expect(toggleCompactControlsMenuForShortcut("runtime-mode", "runtime-mode")).toBeNull();
  });

  it("closes a menu that was opened directly", () => {
    expect(toggleCompactControlsMenuForShortcut("direct", "model-options")).toBeNull();
    expect(toggleCompactControlsMenuForShortcut("direct", "runtime-mode")).toBeNull();
  });
});

describe("getComposerProviderState", () => {
  it("derives a stable prompt injection state for ordinary prompt edits", () => {
    expect(getComposerPromptInjectionState("Investigate this failure")).toBe("none");
    expect(getComposerPromptInjectionState("Ultrathink:\nInvestigate this failure")).toBe(
      "ultrathink",
    );
  });

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
      modelOptions: selections(["anything", "value"]),
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: null,
      modelOptionsForDispatch: undefined,
    });
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
      promptInjectionState: getComposerPromptInjectionState(
        "Ultrathink:\nInvestigate this failure",
      ),
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
      promptInjectionState: getComposerPromptInjectionState(
        "Ultrathink:\nInvestigate this failure",
      ),
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
