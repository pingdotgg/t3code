import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { resolveAutoSettleCompletedChangeRequests } from "./threadListV2";

/**
 * Resolved completed-PR auto-settle preference: the device-local choice if
 * set, otherwise the default (on). Matches web ClientSettings semantics.
 */
export function useAutoSettleCompletedChangeRequests(): boolean {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  return resolveAutoSettleCompletedChangeRequests({
    preference: loaded ? preferencesResult.value.autoSettleCompletedChangeRequests : undefined,
    preferencesLoaded: loaded,
  });
}
