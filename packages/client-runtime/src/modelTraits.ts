import type {
  ModelSelection,
  ProviderOptionSelection,
  ProviderDriverKind,
  ProviderOptionDescriptor,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
} from "@t3tools/shared/model";
import { REASONING_EFFORT_OPTION_IDS } from "./state/threadExecution.ts";

export const DAYBREAK_OPTION_ID = "cyberAccessProgram";

export function daybreakLabel(value: string | boolean | undefined): string | null {
  return value === "daybreakBlue"
    ? "Daybreak Blue"
    : value === "daybreakRed"
      ? "Daybreak Red"
      : null;
}

export function preserveExplicitDaybreakOption(
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
  explicit: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  const program = explicit?.find((option) => option.id === DAYBREAK_OPTION_ID);
  return program
    ? [...(options ?? []).filter((option) => option.id !== DAYBREAK_OPTION_ID), program]
    : options;
}

export function getModelTraitDescriptors(
  input: Parameters<typeof getProviderOptionDescriptors>[0],
) {
  const program = input.selections?.find((option) => option.id === DAYBREAK_OPTION_ID);
  // Revocation must reach backend validation, including when another trait changes.
  return getProviderOptionDescriptors(input).map((descriptor) =>
    descriptor.id === DAYBREAK_OPTION_ID &&
    descriptor.type === "select" &&
    typeof program?.value === "string"
      ? { ...descriptor, currentValue: program.value }
      : descriptor,
  );
}

export function visibleModelTraitDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  allowDaybreak = true,
) {
  return descriptors.filter(
    (descriptor) =>
      descriptor.id !== DAYBREAK_OPTION_ID ||
      (allowDaybreak &&
        descriptor.type === "select" &&
        (descriptor.options.some((option) => daybreakLabel(option.id) !== null) ||
          // Keep advertised Off reachable after the active program is revoked.
          daybreakLabel(descriptor.currentValue) !== null)),
  );
}

export function decideDaybreakModelChange(
  currentOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  target: ModelSelection,
  targetDescriptors: ReadonlyArray<ProviderOptionDescriptor>,
) {
  const descriptor = targetDescriptors.find(
    (entry) => entry.id === DAYBREAK_OPTION_ID && entry.type === "select",
  );
  const choices = descriptor?.type === "select" ? descriptor.options : [];
  const current = currentOptions?.find((option) => option.id === DAYBREAK_OPTION_ID)?.value;
  const activeLabel = daybreakLabel(current);
  const select = (value: string | undefined): ModelSelection => ({
    ...target,
    options: [
      ...(target.options ?? []).filter((option) => option.id !== DAYBREAK_OPTION_ID),
      ...(value ? [{ id: DAYBREAK_OPTION_ID, value }] : []),
    ],
  });
  if (!activeLabel && (!descriptor || choices.some((choice) => choice.id === "standard"))) {
    // Preserve model-only updates so the caller can retain unrelated sticky traits.
    if (!target.options?.some((option) => option.id === DAYBREAK_OPTION_ID))
      return { type: "ready" as const, selection: target };
    // Daybreak follows the current selection, never a target's old remembered program.
    return {
      type: "ready" as const,
      selection: select(
        choices.some((choice) => choice.id === "standard") ? "standard" : undefined,
      ),
    };
  }
  if (typeof current === "string" && choices.some((choice) => choice.id === current)) {
    return { type: "ready" as const, selection: select(current) };
  }
  return {
    type: "confirm" as const,
    activeLabel: activeLabel ?? "Daybreak Off",
    choices: getDaybreakModelChangeChoices(target, targetDescriptors),
  };
}

export function getDaybreakModelChangeChoices(
  target: ModelSelection,
  targetDescriptors: ReadonlyArray<ProviderOptionDescriptor>,
) {
  const descriptor = targetDescriptors.find(
    (entry) => entry.id === DAYBREAK_OPTION_ID && entry.type === "select",
  );
  const choices = descriptor?.type === "select" ? descriptor.options : [];
  const select = (value: string | undefined): ModelSelection => ({
    ...target,
    options: [
      ...(target.options ?? []).filter((option) => option.id !== DAYBREAK_OPTION_ID),
      ...(value ? [{ id: DAYBREAK_OPTION_ID, value }] : []),
    ],
  });
  return [
    ...choices.flatMap((choice) =>
      daybreakLabel(choice.id)
        ? [
            {
              label: choice.id === "daybreakBlue" ? "Use Blue" : "Use Red",
              selection: select(choice.id),
            },
          ]
        : [],
    ),
    ...(!descriptor || choices.some((choice) => choice.id === "standard")
      ? [
          {
            label: "Turn Off",
            selection: select(descriptor ? "standard" : undefined),
          },
        ]
      : []),
  ];
}

export const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";

export const REASONING_SELECT_DESCRIPTOR_IDS: ReadonlySet<string> = new Set([
  ...REASONING_EFFORT_OPTION_IDS,
  "thinking",
]);

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

export function selectableProviderOptionChoices(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
) {
  return descriptor.id === DAYBREAK_OPTION_ID
    ? descriptor.options.filter(
        (option) => option.id === "standard" || daybreakLabel(option.id) !== null,
      )
    : descriptor.options;
}

export function getPromptControlledTraits(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  prompt: string,
  allowPromptInjectedEffort = true,
) {
  const primarySelectDescriptor =
    descriptors.find(
      (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
        descriptor.type === "select" &&
        descriptor.id !== DAYBREAK_OPTION_ID &&
        descriptor.id !== "serviceTier",
    ) ?? null;
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
    modelOptions?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  },
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
  prompt: string,
  value: string,
) {
  if (!value) return null;
  if (descriptor.promptInjectedValues?.includes(value)) {
    return {
      prompt:
        prompt.trim().length === 0
          ? ULTRATHINK_PROMPT_PREFIX
          : applyClaudePromptEffortPrefix(prompt, "ultrathink"),
    };
  }
  const isPrimary = descriptor.id === selected.primarySelectDescriptor?.id;
  if (isPrimary && selected.ultrathinkInBodyText) return null;
  return {
    prompt:
      isPrimary && selected.ultrathinkPromptControlled
        ? prompt.replace(/^Ultrathink:\s*/i, "")
        : prompt,
    modelOptions: preserveExplicitDaybreakOption(
      buildProviderOptionSelectionsFromDescriptors(
        replaceDescriptorCurrentValue(selected.descriptors, descriptor.id, value),
      ),
      descriptor.id === DAYBREAK_OPTION_ID ? undefined : selected.modelOptions,
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
}): { label: string } {
  let fastModeFallbackLabel: string | null = null;
  let speedLabel: string | null = null;
  let reasoningLabelIndex = -1;
  const labels: Array<string> = [];
  for (const descriptor of input.descriptors) {
    if (descriptor.id === DAYBREAK_OPTION_ID) {
      const label = daybreakLabel(
        getProviderOptionCurrentValue(
          descriptor,
          input.modelSelection,
          input.reportedModelSelection,
        ),
      );
      if (label) labels.push(label);
      continue;
    }
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
      if (
        reasoningLabelIndex === -1 &&
        descriptor.type === "select" &&
        REASONING_SELECT_DESCRIPTOR_IDS.has(descriptor.id)
      ) {
        reasoningLabelIndex = labels.length;
      }
      labels.push(label);
    }
  }

  if (labels.length === 0 && fastModeFallbackLabel !== null) {
    return { label: fastModeFallbackLabel };
  }
  if (speedLabel) {
    if (reasoningLabelIndex >= 0) {
      labels[reasoningLabelIndex] = `${labels[reasoningLabelIndex]} ${speedLabel}`;
    } else {
      labels.push(speedLabel);
    }
  }
  return { label: labels.join(" · ") };
}
