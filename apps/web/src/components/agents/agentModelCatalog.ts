import type { ClientSettings } from "@t3tools/contracts/settings";
import type { ServerProvider } from "@t3tools/contracts";

export function visibleAgentProviders(
  environmentId: string,
  providers: ReadonlyArray<ServerProvider>,
  settings: Pick<ClientSettings, "providerModelPreferences">,
) {
  return providers.map((provider) => ({
    ...provider,
    environmentId,
    models: provider.models.filter(
      (model) =>
        model.isCustom ||
        !settings.providerModelPreferences?.[provider.instanceId]?.hiddenModels.includes(
          model.slug,
        ),
    ),
  }));
}

export function agentModelOptions(
  providers: ReadonlyArray<ServerProvider & { readonly environmentId: string }>,
  environmentIds: ReadonlyArray<string>,
  providerLabel: string,
) {
  return [
    ...new Map(
      providers
        .filter(
          (provider) =>
            provider.enabled &&
            (environmentIds.length === 0 || environmentIds.includes(provider.environmentId)) &&
            (provider.displayName?.trim() || provider.driver) === providerLabel,
        )
        .flatMap((provider) => provider.models.map((model) => [model.slug, model] as const)),
    ).values(),
  ].sort(
    (left, right) => left.name.localeCompare(right.name) || left.slug.localeCompare(right.slug),
  );
}
