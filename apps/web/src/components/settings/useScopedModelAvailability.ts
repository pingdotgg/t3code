import {
  type ProviderInstanceId,
  type ServerProvider,
  textGeneratorForSelection,
  type UnifiedSettings,
} from "@t3tools/contracts";

import { mergeEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { resolveScopedModelInstanceId } from "./scopedModelSelection";
import { useSettingsScope } from "./SettingsScopeContext";

export function useScopedModelDisabledReason(
  settings: UnifiedSettings,
  entries: readonly ProviderInstanceEntry[],
) {
  const { targets, target: source } = useSettingsScope();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  return (instanceId: ProviderInstanceId, model: string): string | null => {
    const sourceEntry = entries.find((entry) => entry.instanceId === instanceId);
    const sourceEnvironment = {
      providers: (source && providersByEnvironment.get(source.environmentId)) ?? [],
    };
    const shownGenerator = textGeneratorForSelection(settings, instanceId);
    const peers: ServerProvider[] = [];
    for (const candidate of targets) {
      const environment = environments.find(
        (entry) => entry.environmentId === candidate.environmentId,
      );
      const unavailable = `This model is unavailable on ${environment?.label ?? "a selected environment"}. Select that environment to choose its model separately.`;
      const generator = textGeneratorForSelection(candidate.settings, instanceId);
      if (shownGenerator !== undefined || generator !== undefined) {
        // Only the shown environment's model list is loaded; elsewhere it must reach the same API.
        if (
          !generator?.enabled ||
          generator.kind !== shownGenerator?.kind ||
          generator.baseUrl !== shownGenerator.baseUrl
        ) {
          return unavailable;
        }
        continue;
      }
      const providers = providersByEnvironment.get(candidate.environmentId);
      if (!environment?.serverConfig || !providers) continue;
      const localId = resolveScopedModelInstanceId(
        instanceId,
        sourceEnvironment,
        { providers, settings: candidate.settings },
        peers,
      );
      if (localId === null) {
        return `A unique matching account could not be verified on ${environment.label}. Select that environment to choose its model separately.`;
      }
      peers.push(providers.find((provider) => provider.instanceId === localId)!);
      const entry = applyProviderInstanceSettings(
        deriveProviderInstanceEntries(providers),
        candidate.settings,
        candidate.projectId,
      ).find((option) => option.instanceId === localId);
      const options = getCustomModelOptionsByInstance(
        mergeEnvironmentSettings(candidate.settings, settings),
        providers,
      ).get(localId);
      if (
        !entry?.enabled ||
        !entry.isAvailable ||
        entry.driverKind !== sourceEntry?.driverKind ||
        !options?.some((option) => option.slug === model && !option.isUnavailable)
      ) {
        return unavailable;
      }
    }
    return null;
  };
}
