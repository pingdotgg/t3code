import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { resolveLegacyPlanModeEnabled } from "./legacy-plan-mode";

/**
 * Mobile preferences are device-local, matching the desktop client setting.
 * Keep the legacy composer mode hidden until the preference has loaded and is
 * explicitly enabled.
 */
export function useLegacyPlanModeState(): { readonly enabled: boolean; readonly loaded: boolean } {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferences);
  return {
    enabled: resolveLegacyPlanModeEnabled({
      loaded,
      preference: loaded ? preferences.value.planModeEnabled : undefined,
    }),
    loaded,
  };
}
