import { useEffect } from "react";

import {
  useClientSettingsHydrated,
  usePrimarySettings,
  useUpdatePrimarySettings,
} from "./hooks/useSettings";
import { resolvePlanAgentHealPatch } from "./modelSelection";

/**
 * Heals persisted text-generation model selections that still reference the
 * opencode "plan" agent. The dropdown hides the option while legacy plan mode
 * is off, but the toggle handler only runs when the setting flips; users who
 * already have plan mode off with a stored "plan" selection need this pass
 * whenever the settings load.
 */
export function PlanAgentSelectionHeal() {
  const planModeEnabled = usePrimarySettings((settings) => settings.planModeEnabled);
  const textGenerationModelSelection = usePrimarySettings(
    (settings) => settings.textGenerationModelSelection,
  );
  const sourceControlWriterModelSelection = usePrimarySettings(
    (settings) => settings.sourceControlWriterModelSelection,
  );
  const settingsHydrated = useClientSettingsHydrated();
  const updateSettings = useUpdatePrimarySettings();

  useEffect(() => {
    // planModeEnabled reads as false until client settings hydrate, so never
    // heal before then: we would strip a stored plan selection from a user
    // whose plan mode is actually on.
    if (!settingsHydrated) {
      return;
    }
    const patch = resolvePlanAgentHealPatch({
      planModeEnabled,
      textGenerationModelSelection,
      sourceControlWriterModelSelection,
    });
    if (patch) {
      updateSettings(patch);
    }
  }, [
    planModeEnabled,
    settingsHydrated,
    textGenerationModelSelection,
    sourceControlWriterModelSelection,
    updateSettings,
  ]);

  return null;
}
