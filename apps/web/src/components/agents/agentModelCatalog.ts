import type { ClientSettings } from "@t3tools/contracts/settings";
import type { ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { findReasoningEffortDescriptor } from "@t3tools/shared/model";

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

/** The picker label for a preset's provider: an enabled match by driver or name, else the raw value. */
export function presetProviderLabel(providers: ReadonlyArray<ServerProvider>, provider: string) {
  const wanted = provider.toLowerCase();
  const match = providers.find(
    (candidate) =>
      candidate.enabled &&
      (candidate.driver.toLowerCase() === wanted ||
        candidate.displayName?.trim().toLowerCase() === wanted),
  );
  return match ? match.displayName?.trim() || match.driver : provider;
}

/**
 * Thinking levels for the agent editor: the levels the model's reasoning control advertises (the
 * control runs apply the saved value to), plus the saved value when the model no longer lists it.
 */
export function agentThinkingChoices(
  model: Pick<ServerProviderModel, "capabilities"> | undefined,
  current: string,
): ReadonlyArray<{ readonly value: string; readonly label: string }> {
  const descriptor = findReasoningEffortDescriptor(model?.capabilities?.optionDescriptors);
  const levels = (descriptor?.options ?? [])
    .filter((option) => !descriptor?.promptInjectedValues?.includes(option.id))
    .map((option) => ({ value: option.id, label: option.label }));
  return current && !levels.some((level) => level.value === current)
    ? [...levels, { value: current, label: `${current} (not offered by this model)` }]
    : levels;
}
