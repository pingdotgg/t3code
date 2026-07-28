import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { resolveChangeRequestSettleIdleMs } from "../../lib/settlementPreferences";
import { mobilePreferencesAtom } from "../../state/preferences";
import { resolveThreadListV2Enabled } from "./threadListV2";

/**
 * Resolved Thread List v2 state: on unless the device opted into the legacy
 * grouped list (Settings → Legacy). Every consumer must read through this
 * rather than the raw preference, which is undefined until explicitly chosen.
 */
export function useThreadListV2Enabled(): boolean {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  return resolveThreadListV2Enabled({
    legacyPreference: loaded ? preferencesResult.value.legacyThreadListEnabled : undefined,
    preferencesLoaded: loaded,
  });
}

export function useThreadListV2ChangeRequestSettleIdleMs(): number {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  return resolveChangeRequestSettleIdleMs(
    AsyncResult.isSuccess(preferencesResult)
      ? preferencesResult.value.changeRequestSettleIdleMinutes
      : undefined,
  );
}
