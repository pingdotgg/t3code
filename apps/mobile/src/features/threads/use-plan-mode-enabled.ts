import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { resolvePlanModeEnabled } from "./plan-mode";

export function usePlanModePreferenceState() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  return {
    enabled: resolvePlanModeEnabled(loaded ? preferencesResult.value.planModeEnabled : undefined),
    loaded,
  } as const;
}

export function usePlanModeEnabled(): boolean {
  return usePlanModePreferenceState().enabled;
}
