import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderOptionDescriptor,
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
  provider: ProviderDriverKind;
  descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  primarySelectDescriptorId: string | null;
  ultrathinkPromptControlled: boolean;
  modelSelection?: ModelSelection | null;
  reportedModelSelection?: ModelSelection | null | undefined;
}): {
  label: string;
  /** "Fast" or "Ultrafast" when a speed option is on. */
  speedLabel: string | null;
} {
  let fastModeFallbackLabel: string | null = null;
  let speedLabel: string | null = null;
  let reasoningLabelIndex = -1;
  const labels: Array<string> = [];
  for (const descriptor of input.descriptors) {
    if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
      speedLabel = descriptor.currentValue === true ? "Fast" : null;
      fastModeFallbackLabel = speedLabel ?? "Normal";
      continue;
    }
    if (
      input.provider === "codex" &&
      descriptor.id === "serviceTier" &&
      descriptor.type === "select"
    ) {
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
          : getProviderOptionCurrentLabel(
              descriptor,
              input.modelSelection,
              input.reportedModelSelection,
            );
    if (typeof label === "string" && label.length > 0) {
      if (reasoningLabelIndex === -1 && isReasoningSelect(descriptor)) {
        reasoningLabelIndex = labels.length;
      }
      labels.push(label);
    }
  }

  if (labels.length === 0 && fastModeFallbackLabel !== null) {
    return { label: fastModeFallbackLabel, speedLabel };
  }
  if (speedLabel) {
    if (reasoningLabelIndex >= 0) {
      labels[reasoningLabelIndex] = `${labels[reasoningLabelIndex]} ${speedLabel}`;
    } else {
      labels.push(speedLabel);
    }
  }
  return { label: labels.join(" · "), speedLabel };
}
