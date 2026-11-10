import type {
  ModelSelection,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  isClaudeUltrathinkPrompt,
} from "@t3tools/shared/model";
import { REASONING_EFFORT_OPTION_IDS } from "./state/threadExecution.ts";

const REASONING_DESCRIPTOR_IDS: ReadonlySet<string> = new Set([
  ...REASONING_EFFORT_OPTION_IDS,
  "thinking",
]);

/** The model's reasoning control: a known effort id, or a select its agent marked as reasoning. */
export function isReasoningControl(descriptor: ProviderOptionDescriptor): boolean {
  return (
    (descriptor.type === "select" && descriptor.role === "reasoning") ||
    REASONING_DESCRIPTOR_IDS.has(descriptor.id)
  );
}

export function isReasoningSelect(
  descriptor: ProviderOptionDescriptor,
): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> {
  return descriptor.type === "select" && isReasoningControl(descriptor);
}

function withoutPlanAgentOption(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<ProviderOptionDescriptor> {
  return descriptors.flatMap((descriptor) => {
    if (descriptor.id !== "agent" || descriptor.type !== "select") return [descriptor];
    const options = descriptor.options.filter((option) => option.id !== "plan");
    if (options.length === 0) return [];
    const currentValue =
      descriptor.currentValue && options.some((option) => option.id === descriptor.currentValue)
        ? descriptor.currentValue
        : (options.find((option) => option.isDefault)?.id ?? options[0]?.id);
    return [{ ...descriptor, options, ...(currentValue ? { currentValue } : {}) }];
  });
}

export function preserveExplicitAgentDescriptor(input: {
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly preserve: boolean;
  readonly includePlanAgent?: boolean;
}): ReadonlyArray<ProviderOptionDescriptor> {
  if (!input.preserve) return input.descriptors;
  const savedAgent = input.selections?.find((option) => option.id === "agent");
  if (!savedAgent || typeof savedAgent.value !== "string") return input.descriptors;
  if (savedAgent.value === "plan" && !input.includePlanAgent) {
    return withoutPlanAgentOption(input.descriptors);
  }
  const existing = input.descriptors.find(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.id === "agent" && descriptor.type === "select",
  );
  const agentDescriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
    ...(existing ?? { id: "agent", label: "Agent", type: "select", options: [] }),
    options: [
      ...(existing?.options ?? []).map(({ isDefault: _isDefault, ...option }) => option),
      ...((existing?.options.some((option) => option.id === savedAgent.value) ?? false)
        ? []
        : [{ id: savedAgent.value, label: savedAgent.value }]),
    ],
    currentValue: savedAgent.value,
  };
  const index = input.descriptors.findIndex((descriptor) => descriptor.id === "agent");
  return index < 0
    ? [...input.descriptors, agentDescriptor]
    : input.descriptors.map((descriptor, descriptorIndex) =>
        descriptorIndex === index ? agentDescriptor : descriptor,
      );
}

export function replaceDescriptorCurrentValue(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  descriptorId: string,
  currentValue: string | boolean | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return descriptors.map((descriptor) =>
    descriptor.id !== descriptorId
      ? descriptor
      : descriptor.type === "boolean"
        ? {
            ...descriptor,
            ...(typeof currentValue === "boolean" ? { currentValue } : {}),
          }
        : {
            ...descriptor,
            ...(typeof currentValue === "string" ? { currentValue } : {}),
          },
  );
}

export function getDescriptorStringValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | null,
  selection?: ModelSelection | null,
  reportedSelection?: ModelSelection | null,
): string | null {
  if (!descriptor) {
    return null;
  }
  const value = getProviderOptionCurrentValue(descriptor, selection, reportedSelection);
  return typeof value === "string" ? value : null;
}

// Prompt-injected levels such as Ultrathink still work when typed, but pickers do not offer them.
export function selectableProviderOptionChoices(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
) {
  return descriptor.options.filter(
    (option) => !descriptor.promptInjectedValues?.includes(option.id),
  );
}

export function getPromptControlledTraits(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  prompt: string,
  allowPromptInjectedEffort = true,
) {
  const primarySelectDescriptor =
    descriptors.find((descriptor) => descriptor.type === "select") ?? null;
  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    isClaudeUltrathinkPrompt(prompt);
  const ultrathinkInBodyText =
    ultrathinkPromptControlled && isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, ""));
  return { primarySelectDescriptor, ultrathinkPromptControlled, ultrathinkInBodyText };
}

export function getTraitSelectChange(
  selected: ReturnType<typeof getPromptControlledTraits> & {
    descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  },
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
  prompt: string,
  value: string,
) {
  if (!value || descriptor.promptInjectedValues?.includes(value)) return null;
  const isPrimary = descriptor.id === selected.primarySelectDescriptor?.id;
  if (isPrimary && selected.ultrathinkInBodyText) return null;
  return {
    prompt:
      isPrimary && selected.ultrathinkPromptControlled
        ? prompt.replace(/^Ultrathink:\s*/i, "")
        : prompt,
    modelOptions: buildProviderOptionSelectionsFromDescriptors(
      replaceDescriptorCurrentValue(selected.descriptors, descriptor.id, value),
    ),
  };
}

export function buildTraitsTriggerDisplay(input: {
  descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  primarySelectDescriptorId: string | null;
  ultrathinkPromptControlled: boolean;
  modelSelection?: ModelSelection | null;
  reportedModelSelection?: ModelSelection | null | undefined;
}): {
  label: string;
  /** "Fast" or "Ultrafast" when a speed option is on. */
  speedLabel: string | null;
  ultracode: boolean;
} {
  let fastModeFallbackLabel: string | null = null;
  let speedLabel: string | null = null;
  let reasoningLabelIndex = -1;
  let ultracodeLabelIndex = -1;
  const labels: Array<string> = [];
  for (const descriptor of input.descriptors) {
    if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
      speedLabel = descriptor.currentValue === true ? "Fast" : null;
      fastModeFallbackLabel = speedLabel ?? "Normal";
      continue;
    }
    if (descriptor.id === "ultracode" && descriptor.type === "boolean") {
      if (descriptor.currentValue === true) {
        ultracodeLabelIndex = labels.length;
        labels.push(descriptor.label);
      }
      continue;
    }
    if (descriptor.id === "serviceTier" && descriptor.type === "select") {
      const currentValue = getProviderOptionCurrentValue(descriptor);
      const fastTier = descriptor.options.find(({ label }) => label === "Fast");
      const ultrafastTier = descriptor.options.find(({ label }) => label === "Ultrafast");
      if (
        ((fastTier || ultrafastTier) && currentValue === "default") ||
        (fastTier && currentValue === fastTier.id) ||
        (ultrafastTier && currentValue === ultrafastTier.id)
      ) {
        speedLabel =
          ultrafastTier && currentValue === ultrafastTier.id
            ? "Ultrafast"
            : fastTier && currentValue === fastTier.id
              ? "Fast"
              : null;
        fastModeFallbackLabel =
          descriptor.options.find(({ id }) => id === currentValue)?.label ?? "Normal";
        continue;
      }
    }
    const label =
      input.ultrathinkPromptControlled && descriptor.id === input.primarySelectDescriptorId
        ? "Ultrathink"
        : descriptor.type === "boolean"
          ? `${descriptor.label} ${descriptor.currentValue === true ? "On" : "Off"}`
          : (getProviderOptionCurrentLabel(
              descriptor,
              input.modelSelection,
              input.reportedModelSelection,
            ) ?? (descriptor.id === "thinking" ? descriptor.label : null));
    if (typeof label === "string" && label.length > 0) {
      if (reasoningLabelIndex === -1 && isReasoningSelect(descriptor)) {
        reasoningLabelIndex = labels.length;
      }
      labels.push(label);
    }
  }

  const ultracode = ultracodeLabelIndex >= 0;
  if (labels.length === 0 && fastModeFallbackLabel !== null) {
    return { label: fastModeFallbackLabel, speedLabel, ultracode };
  }
  if (speedLabel) {
    if (reasoningLabelIndex >= 0) {
      labels[reasoningLabelIndex] = `${labels[reasoningLabelIndex]} ${speedLabel}`;
    } else {
      labels.push(speedLabel);
    }
  }
  return { label: labels.join(" · "), speedLabel, ultracode };
}
