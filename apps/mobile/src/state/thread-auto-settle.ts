import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { mobilePreferencesAtom } from "./preferences";
import {
  DEFAULT_MOBILE_THREAD_AUTO_SETTLE_POLICY,
  resolveMobileThreadAutoSettlePolicy,
} from "./thread-auto-settle.logic";

export * from "./thread-auto-settle.logic";

export function useMobileThreadAutoSettlePolicy() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferencesResult)
    ? resolveMobileThreadAutoSettlePolicy(preferencesResult.value)
    : DEFAULT_MOBILE_THREAD_AUTO_SETTLE_POLICY;
}
