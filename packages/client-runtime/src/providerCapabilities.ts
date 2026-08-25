import type { ModelSelection, ProviderInteractionMode, ServerProvider } from "@t3tools/contracts";

export function selectedProviderShowsInteractionModeToggle(
  providers: ReadonlyArray<ServerProvider>,
  selection: Pick<ModelSelection, "instanceId"> | null | undefined,
): boolean {
  if (!selection) return true;
  return (
    providers.find((provider) => provider.instanceId === selection.instanceId)
      ?.showInteractionModeToggle ?? true
  );
}

export function normalizeProviderInteractionMode(
  providers: ReadonlyArray<ServerProvider>,
  selection: Pick<ModelSelection, "instanceId"> | null | undefined,
  interactionMode: ProviderInteractionMode,
): ProviderInteractionMode {
  return interactionMode === "plan" &&
    !selectedProviderShowsInteractionModeToggle(providers, selection)
    ? "default"
    : interactionMode;
}
