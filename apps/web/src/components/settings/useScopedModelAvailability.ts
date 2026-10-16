import type { ProviderInstanceId, UnifiedSettings } from "@t3tools/contracts";
import { useCallback } from "react";

import { mergeEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { useSettingsScope } from "./SettingsScopeContext";

export function useScopedModelDisabledReason(
  settings: UnifiedSettings,
  entries: readonly ProviderInstanceEntry[],
) {
  const { targets } = useSettingsScope();
  const { environments } = useEnvironments();
  return useCallback(
    (instanceId: ProviderInstanceId, model: string): string | null => {
      const sourceEntry = entries.find((entry) => entry.instanceId === instanceId);
      for (const candidate of targets) {
        const environment = environments.find(
          (entry) => entry.environmentId === candidate.environmentId,
        );
        const config = environment?.serverConfig;
        if (!config) continue;
        const entry = applyProviderInstanceSettings(
          deriveProviderInstanceEntries(config.providers),
          candidate.settings,
          candidate.projectId,
        ).find((option) => option.instanceId === instanceId);
        const options = getCustomModelOptionsByInstance(
          mergeEnvironmentSettings(candidate.settings, settings),
          config.providers,
        ).get(instanceId);
        if (
          !entry?.enabled ||
          !entry.isAvailable ||
          entry.driverKind !== sourceEntry?.driverKind ||
          !options?.some((option) => option.slug === model && !option.isUnavailable)
        ) {
          return `This model is unavailable on ${environment?.label ?? "a selected environment"}. Select that environment to choose its model separately.`;
        }
      }
      return null;
    },
    [entries, environments, settings, targets],
  );
}
