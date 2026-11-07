import type { ProviderInstanceId, UnifiedSettings } from "@t3tools/contracts";

import { mergeEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { useSettingsScope } from "./SettingsScopeContext";

// Pi is the only producer: its text generation launches without extensions.
const TEXT_GENERATION_UNSUPPORTED_REASON =
  "Pi text generation runs without extensions, so it can't use this model. Choose a built-in Pi model or one from Pi's models.json, and keep extension providers out of Pi's launch arguments.";

export function useScopedModelDisabledReason(
  settings: UnifiedSettings,
  entries: readonly ProviderInstanceEntry[],
  purpose: { readonly forTextGeneration?: boolean } = {},
) {
  const { targets } = useSettingsScope();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  return (instanceId: ProviderInstanceId, model: string): string | null => {
    const sourceEntry = entries.find((entry) => entry.instanceId === instanceId);
    for (const candidate of targets) {
      const environment = environments.find(
        (entry) => entry.environmentId === candidate.environmentId,
      );
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
        return `This model is unavailable on ${environment?.label ?? "a selected environment"}. Select that environment to choose its model separately.`;
      }
      if (
        purpose.forTextGeneration === true &&
        entry.models.find((option) => option.slug === model)?.supportsTextGeneration === false
      ) {
        return TEXT_GENERATION_UNSUPPORTED_REASON;
      }
    }
    return null;
  };
}
