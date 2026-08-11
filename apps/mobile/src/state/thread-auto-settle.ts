import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { mobilePreferencesAtom } from "./preferences";
import { resolveMobileThreadAutoSettlePolicy } from "./thread-auto-settle.logic";

export * from "./thread-auto-settle.logic";

export function useMobileThreadAutoSettlePolicy() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  return resolveMobileThreadAutoSettlePolicy(
    AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : {},
  );
}
