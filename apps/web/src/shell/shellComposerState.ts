import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  RuntimeMode,
  ServerProviderModel,
} from "@t3tools/contracts";
import type { ShellComposerOption, ShellComposerState } from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

import type { AppModelOption } from "../modelSelection";
import type { ProviderInstanceEntry } from "../providerInstances";
import { getProviderModelCapabilities } from "../providerModels";

export interface ShellComposerStateInput {
  readonly target: string | null;
  readonly routeKind: "server" | "draft";
  readonly text: string;
  readonly placeholder: string;
  readonly editorDisabled: boolean;
  readonly hasSendableContent: boolean;
  readonly sendDisabledReason: string | null;
  readonly isRunning: boolean;
  readonly isSendBusy: boolean;
  readonly isConnecting: boolean;
  readonly environmentUnavailable: boolean;
  readonly noProviderAvailable: boolean;
  readonly projectSelectionRequired: boolean;
  readonly pendingApprovalCount: number;
  readonly pendingUserInputCount: number;
  readonly showPlanFollowUpPrompt: boolean;
  readonly selectedInstanceId: ProviderInstanceId | null;
  readonly selectedModel: string | null;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  readonly getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  readonly optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly runtimeMode: RuntimeMode;
  readonly runtimeModes: ReadonlyArray<{ value: RuntimeMode; label: string; description: string }>;
  readonly interactionMode: "default" | "plan";
  readonly showInteractionModeToggle: boolean;
}

/** The option descriptors for a model, with the draft's current selections applied. */
export function resolveComposerOptionDescriptors(input: {
  readonly provider: ProviderDriverKind;
  readonly model: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly planModeEnabled: boolean;
}): ReadonlyArray<ProviderOptionDescriptor> {
  const caps = getProviderModelCapabilities(
    input.models,
    input.model,
    input.provider,
    input.planModeEnabled,
  );
  return getProviderOptionDescriptors({ caps, selections: input.selections });
}

/** Applies one option change and returns the selections to persist on the draft. */
export function applyComposerOptionChange(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  id: string,
  value: string | boolean,
): ModelSelection["options"] {
  const next = descriptors.map((descriptor) => {
    if (descriptor.id !== id) return descriptor;
    if (descriptor.type === "select") {
      return typeof value === "string" && descriptor.options.some((choice) => choice.id === value)
        ? { ...descriptor, currentValue: value }
        : descriptor;
    }
    return typeof value === "boolean" ? { ...descriptor, currentValue: value } : descriptor;
  });
  return buildProviderOptionSelectionsFromDescriptors(next);
}

function toShellOption(descriptor: ProviderOptionDescriptor): ShellComposerOption {
  return descriptor.type === "select"
    ? {
        id: descriptor.id,
        label: descriptor.label,
        type: "select",
        value: descriptor.currentValue ?? null,
        choices: descriptor.options.map((choice) => ({ id: choice.id, label: choice.label })),
      }
    : {
        id: descriptor.id,
        label: descriptor.label,
        type: "boolean",
        value: descriptor.currentValue ?? null,
        choices: [],
      };
}

export function buildShellComposerState(input: ShellComposerStateInput): ShellComposerState {
  const blocked =
    input.isSendBusy ||
    input.isConnecting ||
    input.environmentUnavailable ||
    input.noProviderAvailable ||
    input.projectSelectionRequired ||
    input.sendDisabledReason !== null;
  return {
    target: input.target,
    routeKind: input.routeKind,
    text: input.text,
    placeholder: input.placeholder,
    editorDisabled: input.editorDisabled,
    canSend: !blocked && (input.hasSendableContent || input.showPlanFollowUpPrompt),
    sendDisabledReason:
      input.sendDisabledReason ??
      (input.environmentUnavailable
        ? "Not connected"
        : input.noProviderAvailable
          ? "No provider available"
          : input.projectSelectionRequired
            ? "Choose a project first"
            : null),
    isRunning: input.isRunning,
    isSendBusy: input.isSendBusy,
    isConnecting: input.isConnecting,
    pendingApprovalCount: input.pendingApprovalCount,
    pendingUserInputCount: input.pendingUserInputCount,
    showPlanFollowUpPrompt: input.showPlanFollowUpPrompt,
    selectedInstanceId: input.selectedInstanceId,
    selectedModel: input.selectedModel,
    instances: input.instanceEntries
      .filter((entry) => entry.enabled)
      .map((entry) => ({
        instanceId: entry.instanceId,
        driverKind: entry.driverKind,
        displayName: entry.displayName,
        isAvailable: entry.isAvailable,
        models: (input.modelOptionsByInstance.get(entry.instanceId) ?? []).map((option) => ({
          slug: option.slug,
          name: option.name,
          disabledReason: input.getModelDisabledReason(entry.instanceId, option.slug),
        })),
      })),
    options: input.optionDescriptors.map(toShellOption),
    runtimeMode: input.runtimeMode,
    runtimeModes: input.runtimeModes,
    interactionMode: input.interactionMode,
    showInteractionModeToggle: input.showInteractionModeToggle,
  };
}
