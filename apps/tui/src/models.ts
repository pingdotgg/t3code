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
