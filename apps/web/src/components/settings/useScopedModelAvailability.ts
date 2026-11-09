import {
  type ProviderInstanceId,
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
import { useSettingsScope } from "./SettingsScopeContext";

export function useScopedModelDisabledReason(
  settings: UnifiedSettings,
  entries: readonly ProviderInstanceEntry[],
) {
  const { targets } = useSettingsScope();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  return (instanceId: ProviderInstanceId, model: string): string | null => {
    const sourceEntry = entries.find((entry) => entry.instanceId === instanceId);
    const isTextGenerator = textGeneratorForSelection(settings, instanceId) !== undefined;
    for (const candidate of targets) {
      const environment = environments.find(
        (entry) => entry.environmentId === candidate.environmentId,
      );
      const unavailable = `This model is unavailable on ${environment?.label ?? "a selected environment"}. Select that environment to choose its model separately.`;
      const generator = textGeneratorForSelection(candidate.settings, instanceId);
      if (isTextGenerator || generator !== undefined) {
        // Only the shown environment's model list is loaded; elsewhere the generator must match.
        if (!generator?.enabled || generator.kind !== sourceEntry?.driverKind) {
          return unavailable;
        }
        continue;
      }
      const providers = providersByEnvironment.get(candidate.environmentId);
      if (!environment?.serverConfig || !providers) continue;
      const entry = applyProviderInstanceSettings(
        deriveProviderInstanceEntries(providers),
        candidate.settings,
        candidate.projectId,
      ).find((option) => option.instanceId === instanceId);
      const options = getCustomModelOptionsByInstance(
        mergeEnvironmentSettings(candidate.settings, settings),
        providers,
      ).get(instanceId);
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
