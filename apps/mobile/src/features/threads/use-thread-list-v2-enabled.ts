import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { resolveThreadListV2Enabled } from "./threadListV2";

/**
 * Resolved Thread List v2 state: the device-local preference if the user has
 * set one, otherwise the default (on). Every consumer must read through this
 * rather than the raw preference, which is undefined until explicitly chosen.
 */
export function useThreadListV2Enabled(): boolean {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  return resolveThreadListV2Enabled({
    preference: loaded ? preferencesResult.value.threadListV2Enabled : undefined,
    preferencesLoaded: loaded,
  });
}
