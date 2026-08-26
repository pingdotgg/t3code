import { describe, expect, it } from "vite-plus/test";
import type { ProviderInstanceId, ProviderOptionDescriptor, RuntimeMode } from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../providerInstances";
import { applyComposerOptionChange, buildShellComposerState } from "./shellComposerState";

const codexInstanceId = "codex" as ProviderInstanceId;

const effortDescriptor: ProviderOptionDescriptor = {
  id: "effort",
  label: "Effort",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
  ],
  currentValue: "low",
};
const thinkingDescriptor: ProviderOptionDescriptor = {
  id: "thinking",
  label: "Thinking",
  type: "boolean",
  currentValue: false,
};

const codexEntry = {
  instanceId: codexInstanceId,
  driverKind: "codex",
  displayName: "Codex",
  enabled: true,
  installed: true,
  isDefault: true,
  isAvailable: true,
} as ProviderInstanceEntry;

const runtimeModes: ReadonlyArray<{ value: RuntimeMode; label: string; description: string }> = [
  { value: "approval-required", label: "Supervised", description: "Ask first." },
  { value: "full-access", label: "Full access", description: "Never ask." },
];

function baseInput() {
  return {
    target: "env:thread-1",
    routeKind: "server" as const,
    text: "hello",
    cursor: 5,
    triggerKind: null,
    suggestions: [],
    suggestionsEmptyText: null,
    placeholder: "Ask anything",
    editorDisabled: false,
    hasSendableContent: true,
    sendDisabledReason: null,
    isRunning: false,
    isSendBusy: false,
    isConnecting: false,
    environmentUnavailable: false,
    noProviderAvailable: false,
    projectSelectionRequired: false,
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
    showPlanFollowUpPrompt: false,
    selectedInstanceId: codexInstanceId,
    selectedModel: "gpt-5.4",
    instanceEntries: [
      codexEntry,
      { ...codexEntry, instanceId: "off" as ProviderInstanceId, enabled: false },
    ],
    modelOptionsByInstance: new Map([
      [
        codexInstanceId,
        [
          { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false },
          { slug: "gpt-5.4-mini", name: "GPT-5.4 mini", isCustom: false },
        ],
      ],
    ]),
    getModelDisabledReason: (_instanceId: ProviderInstanceId, model: string) =>
      model === "gpt-5.4-mini" ? "Started with another model" : null,
    optionDescriptors: [effortDescriptor, thinkingDescriptor],
    runtimeMode: "approval-required" as RuntimeMode,
    runtimeModes,
    interactionMode: "default" as const,
    showInteractionModeToggle: true,
  };
}

describe("buildShellComposerState", () => {
  it("projects enabled instances, their models, and option descriptors", () => {
    const state = buildShellComposerState(baseInput());
    expect(state.canSend).toBe(true);
    expect(state.instances).toEqual([
      {
        instanceId: "codex",
        driverKind: "codex",
        displayName: "Codex",
        isAvailable: true,
        models: [
          { slug: "gpt-5.4", name: "GPT-5.4", disabledReason: null },
          {
            slug: "gpt-5.4-mini",
            name: "GPT-5.4 mini",
            disabledReason: "Started with another model",
          },
        ],
      },
    ]);
    expect(state.options).toEqual([
      {
        id: "effort",
        label: "Effort",
        type: "select",
        value: "low",
        choices: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
      { id: "thinking", label: "Thinking", type: "boolean", value: false, choices: [] },
    ]);
    expect(state.runtimeModes).toHaveLength(2);
  });

  it("blocks sending and explains why", () => {
    expect(buildShellComposerState({ ...baseInput(), noProviderAvailable: true })).toMatchObject({
      canSend: false,
      sendDisabledReason: "No provider available",
    });
    expect(buildShellComposerState({ ...baseInput(), hasSendableContent: false })).toMatchObject({
      canSend: false,
      sendDisabledReason: null,
    });
    expect(
      buildShellComposerState({
        ...baseInput(),
        hasSendableContent: false,
        showPlanFollowUpPrompt: true,
      }).canSend,
    ).toBe(true);
    expect(
      buildShellComposerState({ ...baseInput(), sendDisabledReason: "Messages loading" })
        .sendDisabledReason,
    ).toBe("Messages loading");
  });
});

describe("applyComposerOptionChange", () => {
  it("updates a select option to a valid choice only", () => {
    expect(
      applyComposerOptionChange([effortDescriptor, thinkingDescriptor], "effort", "high"),
    ).toEqual([
      { id: "effort", value: "high" },
      { id: "thinking", value: false },
    ]);
    expect(applyComposerOptionChange([effortDescriptor], "effort", "extreme")).toEqual([
      { id: "effort", value: "low" },
    ]);
  });

  it("updates a boolean option only with a boolean", () => {
    expect(applyComposerOptionChange([thinkingDescriptor], "thinking", true)).toEqual([
      { id: "thinking", value: true },
    ]);
    expect(applyComposerOptionChange([thinkingDescriptor], "thinking", "yes")).toEqual([
      { id: "thinking", value: false },
    ]);
  });
});
