import type { ServerProvider } from "@t3tools/contracts";

// Flatten the server config's providers into a flat, selectable model list for the
// picker. Mirrors the web app's model assembly (apps/web/src/modelSelection.ts) at
// the level the TUI needs: provider + model slug + display labels. Pure.

export interface ModelOption {
  readonly instanceId: string;
  /** The provider-specific model slug sent back as the selection. */
  readonly model: string;
  readonly label: string;
  readonly providerLabel: string;
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
}

const REASONING_DESCRIPTOR_IDS = new Set(["reasoningEffort", "effort", "reasoning"]);

/**
 * The reasoning/effort choices for a model, from its capability descriptors — the
 * named reasoning select if present, else the first select descriptor. Null when
 * the model exposes no select options. Mirrors the web TraitsPicker's data.
 */
export function reasoningChoicesFor(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: string,
  model: string,
): ReasoningChoices | null {
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  const found = provider?.models.find((entry) => entry.slug === model);
  const descriptors = found?.capabilities?.optionDescriptors ?? [];
  const selects = descriptors.filter((descriptor) => descriptor.type === "select");
  const reasoning =
    selects.find((descriptor) => REASONING_DESCRIPTOR_IDS.has(descriptor.id)) ?? selects[0];
  if (!reasoning || reasoning.type !== "select") return null;
  return {
    descriptorId: reasoning.id,
    choices: reasoning.options.map((option) => ({
      id: option.id,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
  };
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
