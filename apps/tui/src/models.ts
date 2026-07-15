import type {
  ModelCapabilities,
  ModelSelection,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ServerProvider,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  createModelSelection,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

// Flatten the server config's providers into a flat, selectable model list for the
// picker. Mirrors the web app's model assembly (apps/web/src/modelSelection.ts) at
// the level the TUI needs: provider + model slug + display labels. Pure.

export interface ModelOption {
  readonly instanceId: ServerProvider["instanceId"];
  /** The provider-specific model slug sent back as the selection. */
  readonly model: string;
  readonly label: string;
  readonly providerLabel: string;
  readonly capabilities: ModelCapabilities | null;
}

export function flattenModelOptions(
  providers: ReadonlyArray<ServerProvider>,
): ModelOption[] {
  const options: ModelOption[] = [];
  for (const provider of providers) {
    const providerLabel = provider.displayName ?? provider.driver ?? provider.instanceId;
    for (const model of provider.models) {
      options.push({
        instanceId: provider.instanceId,
        model: model.slug,
        label: model.shortName ?? model.name ?? model.slug,
        providerLabel,
        capabilities: model.capabilities,
      });
    }
  }
  return options;
}

export interface ReasoningChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface ReasoningChoices {
  readonly descriptorId: string;
  readonly choices: ReadonlyArray<ReasoningChoice>;
  readonly selectedId: string | null;
}

const REASONING_DESCRIPTOR_IDS = new Set(["reasoningEffort", "effort", "reasoning"]);

function reasoningChoicesFromDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReasoningChoices | null {
  const selects = descriptors.filter((descriptor) => descriptor.type === "select");
  const reasoning =
    selects.find((descriptor) => REASONING_DESCRIPTOR_IDS.has(descriptor.id)) ?? selects[0];
  if (!reasoning || reasoning.type !== "select") return null;
  const selected = getProviderOptionCurrentValue(reasoning);
  return {
    descriptorId: reasoning.id,
    choices: reasoning.options.map((option) => ({
      id: option.id,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
    selectedId: typeof selected === "string" ? selected : null,
  };
}

/**
 * The reasoning/effort choices for a model, from its capability descriptors — the
 * named reasoning select if present, else the first select descriptor. Null when
 * the model exposes no select options. Mirrors the web TraitsPicker's data.
 */
export function reasoningChoicesFor(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: string,
  model: string,
  selections?: ReadonlyArray<ProviderOptionSelection>,
): ReasoningChoices | null {
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  const found = provider?.models.find((entry) => entry.slug === model);
  const descriptors = found?.capabilities
    ? getProviderOptionDescriptors({ caps: found.capabilities, selections })
    : [];
  return reasoningChoicesFromDescriptors(descriptors);
}

/**
 * Resolve a model selection the same way the web composer does: capability
 * defaults and current values are materialized into the options sent with a
 * turn, while explicit draft selections win over those defaults.
 */
export function resolveModelSelection(
  options: ReadonlyArray<ModelOption>,
  selection: ModelSelection | null | undefined,
): ModelSelection | null {
  if (!selection) return null;
  const option = options.find(
    (candidate) =>
      candidate.instanceId === selection.instanceId && candidate.model === selection.model,
  );
  const descriptors = option?.capabilities
    ? getProviderOptionDescriptors({
        caps: option.capabilities,
        selections: selection.options,
      })
    : [];
  return createModelSelection(
    selection.instanceId,
    selection.model,
    buildProviderOptionSelectionsFromDescriptors(descriptors) ?? selection.options,
  );
}

/** Create a complete selection for a newly chosen model, using its defaults. */
export function modelSelectionForOption(option: ModelOption): ModelSelection {
  const descriptors = option.capabilities
    ? getProviderOptionDescriptors({ caps: option.capabilities })
    : [];
  return createModelSelection(
    option.instanceId,
    option.model,
    buildProviderOptionSelectionsFromDescriptors(descriptors),
  );
}

/** Replace one provider option without dropping the rest of the model traits. */
export function withModelSelectionOption(
  selection: ModelSelection,
  descriptorId: string,
  value: string | boolean,
): ModelSelection {
  return createModelSelection(selection.instanceId, selection.model, [
    ...(selection.options ?? []).filter((option) => option.id !== descriptorId),
    { id: descriptorId, value },
  ]);
}

/** Effort choices and the resolved current/default value for a flattened model. */
export function reasoningChoicesForSelection(
  options: ReadonlyArray<ModelOption>,
  selection: ModelSelection | null | undefined,
): ReasoningChoices | null {
  if (!selection) return null;
  const model = options.find(
    (option) => option.instanceId === selection.instanceId && option.model === selection.model,
  );
  const descriptors = model?.capabilities
    ? getProviderOptionDescriptors({
        caps: model.capabilities,
        selections: selection.options,
      })
    : [];
  return reasoningChoicesFromDescriptors(descriptors);
}

/** Index of the option matching the current selection, or 0 when none matches. */
export function currentModelIndex(
  options: ReadonlyArray<ModelOption>,
  selection: { readonly instanceId: string; readonly model: string } | null | undefined,
): number {
  if (!selection) return 0;
  const index = options.findIndex(
    (option) => option.instanceId === selection.instanceId && option.model === selection.model,
  );
  return index >= 0 ? index : 0;
}
