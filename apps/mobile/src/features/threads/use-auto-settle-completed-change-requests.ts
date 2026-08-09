import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { resolveAutoSettleCompletedChangeRequests } from "./threadListV2";

export function useAutoSettleCompletedChangeRequests(): boolean {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const preferencesLoaded = AsyncResult.isSuccess(preferencesResult);

  return resolveAutoSettleCompletedChangeRequests({
    preference: preferencesLoaded
      ? preferencesResult.value.autoSettleCompletedChangeRequests
      : undefined,
    preferencesLoaded,
  });
}
