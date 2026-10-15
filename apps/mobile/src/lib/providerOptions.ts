import type {
  ModelCapabilities,
  ModelSelection,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

/** Summarizes the effective reasoning and speed options without changing the selection. */
export function composerModelOptionSummary(input: {
  readonly provider: string | null | undefined;
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly selection: ModelSelection | null;
  readonly reportedSelection?: ModelSelection | null | undefined;
}) {
  const reasoning = input.descriptors.find(
    (descriptor) =>
      descriptor.type === "select" &&
      ["reasoningEffort", "reasoning", "effort", "variant", "thinking"].includes(descriptor.id),
  );
  const thinking = input.descriptors.find(
    (descriptor) => descriptor.type === "boolean" && descriptor.id === "thinking",
  );
  const thinkingValue = getProviderOptionCurrentValue(
    thinking,
    input.selection,
    input.reportedSelection,
  );
  const reasoningValue = getProviderOptionCurrentValue(
    reasoning,
    input.selection,
    input.reportedSelection,
  );
  const reasoningLabel =
    reasoning && reasoningValue !== undefined
      ? getProviderOptionCurrentLabel(reasoning, input.selection, input.reportedSelection)
      : typeof thinkingValue === "boolean"
        ? thinkingValue
          ? "Thinking"
          : "No thinking"
        : undefined;
  const speed = input.descriptors.find(
    (descriptor) =>
      (descriptor.id === "fastMode" && descriptor.type === "boolean") ||
      (input.provider === "codex" &&
        descriptor.id === "serviceTier" &&
        descriptor.type === "select"),
  );
  const speedValue = getProviderOptionCurrentValue(speed, input.selection, input.reportedSelection);
  const speedChoice =
    speed?.type === "select" ? speed.options.find((choice) => choice.id === speedValue) : undefined;
  const speedLabel =
    speed?.type === "boolean"
      ? speedValue === true
        ? "Fast"
        : undefined
      : speedChoice?.label === "Fast" || speedChoice?.label === "Ultrafast"
        ? speedChoice.label
        : undefined;
  return { reasoningLabel, speedLabel };
}

export function resolveProviderOptionDescriptors(input: {
  readonly capabilities: ModelCapabilities | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  if (!input.capabilities) {
    return [];
  }
  return getProviderOptionDescriptors({
    caps: input.capabilities,
    selections: input.selections,
  });
}

/**
 * Applies one option change (by descriptor id) and returns the full selection
 * list to store on the model selection, or null when the change doesn't match
 * an advertised descriptor / choice.
 */
export function applyProviderOptionSelection(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  change: ProviderOptionSelection,
): ReadonlyArray<ProviderOptionSelection> | null {
  const descriptor = descriptors.find((candidate) => candidate.id === change.id);
  if (!descriptor) {
    return null;
  }
  if (
    (descriptor.type === "boolean" && typeof change.value !== "boolean") ||
    (descriptor.type === "select" &&
      (typeof change.value !== "string" ||
        !descriptor.options.some((option) => option.id === change.value)))
  ) {
    return null;
  }

  const nextDescriptors = descriptors.map((candidate) =>
    candidate.id === descriptor.id
      ? {
          ...candidate,
          currentValue: change.value,
        }
      : candidate,
  ) as ReadonlyArray<ProviderOptionDescriptor>;

  return buildProviderOptionSelectionsFromDescriptors(nextDescriptors) ?? [];
}
