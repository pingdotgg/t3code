import type { ProviderInstanceId, ServerSettings, UnifiedSettings } from "@t3tools/contracts";

import { mergeEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { useSettingsScope } from "./SettingsScopeContext";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { scopedDisplaySettings } from "./scopedSettings";

export function useScopedModelSettings(settings: UnifiedSettings, key: keyof ServerSettings) {
  const { target, targets } = useSettingsScope();
  const providersByEnvironment = useEnvironmentProviders();
  const eligible = targets.filter((candidate) => !candidate.unsupportedSettingKeys?.has(key));
  const representative = eligible.find((candidate) => candidate === target) ?? eligible[0];
  return {
    target: representative,
    settings: representative
      ? mergeEnvironmentSettings(scopedDisplaySettings(representative, eligible), settings)
      : settings,
    providers:
      (representative ? providersByEnvironment.get(representative.environmentId) : undefined) ??
      EMPTY_SERVER_PROVIDERS,
  };
}

export function useScopedModelDisabledReason(
  settings: UnifiedSettings,
  entries: readonly ProviderInstanceEntry[],
  key: keyof ServerSettings,
) {
  const { targets } = useSettingsScope();
  const providersByEnvironment = useEnvironmentProviders();
  return (instanceId: ProviderInstanceId, model: string): string | null => {
    const sourceEntry = entries.find((entry) => entry.instanceId === instanceId);
    for (const candidate of targets) {
      if (candidate.unsupportedSettingKeys?.has(key)) continue;
      const providers = (
        providersByEnvironment.get(candidate.environmentId) ?? EMPTY_SERVER_PROVIDERS
      ).filter(
        (provider) => key === "defaultModelSelection" || provider.supportsTextGeneration !== false,
      );
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
        return `This model is unavailable on ${candidate.label}. Select that environment to choose its model separately.`;
      }
    }
    return null;
  };
}
