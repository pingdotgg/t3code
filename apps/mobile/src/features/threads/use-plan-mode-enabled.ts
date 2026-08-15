import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { usePlanModePreferenceReconciliationReady } from "../../state/synced-client-preferences";
import { resolvePlanModeEnabled } from "./plan-mode";

export function usePlanModePreferenceState() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const reconciliationReady = usePlanModePreferenceReconciliationReady();
  const loaded = AsyncResult.isSuccess(preferencesResult) && reconciliationReady;
  return {
    enabled: resolvePlanModeEnabled(loaded ? preferencesResult.value.planModeEnabled : undefined),
    loaded,
  } as const;
}

export function usePlanModeEnabled(): boolean {
  return usePlanModePreferenceState().enabled;
}
