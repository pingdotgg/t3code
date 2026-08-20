import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { usePlanModePreferenceReconciliationReady } from "../../state/synced-client-preferences";
import { resolveLegacyPlanModeEnabled } from "./legacy-plan-mode";

/**
 * Mobile preferences are device-local, matching the desktop client setting.
 * Keep the legacy composer mode hidden until the preference has loaded and is
 * explicitly enabled.
 */
export function useLegacyPlanModeEnabled(): boolean {
  return useLegacyPlanModeState().enabled;
}

export function useLegacyPlanModeState() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const reconciliationReady = usePlanModePreferenceReconciliationReady();
  const loaded = AsyncResult.isSuccess(preferences) && reconciliationReady;
  return {
    enabled: resolveLegacyPlanModeEnabled({
      loaded,
      preference: loaded ? preferences.value.planModeEnabled : undefined,
    }),
    loaded,
  };
}
