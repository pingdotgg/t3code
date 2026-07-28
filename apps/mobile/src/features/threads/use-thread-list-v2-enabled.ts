import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import Constants from "expo-constants";

import { mobilePreferencesAtom } from "../../state/preferences";
import { resolveThreadListV2Enabled } from "./threadListV2";

/**
 * Resolved Thread List v2 state: the device-local preference if the user has
 * set one, otherwise the default for this app variant (on for development and
 * preview, off for production). Every consumer must read through this rather
 * than the raw preference, which is undefined until explicitly chosen.
 *
 * Kept out of `state/preferences.ts` so that module stays importable from node
 * test environments, which have no `__DEV__` for expo-constants.
 */
export function useThreadListV2Enabled(): boolean {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  return resolveThreadListV2Enabled({
    preference: loaded ? preferencesResult.value.threadListV2Enabled : undefined,
    preferencesLoaded: loaded,
    appVariant: Constants.expoConfig?.extra?.appVariant,
  });
}
