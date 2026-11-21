import { useAtomValue } from "@effect/atom-react";
import type { UsageLimitDisplay } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";

export function useUsageLimitDisplay(): UsageLimitDisplay {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? (preferences.value.usageLimitDisplay ?? "left")
    : "left";
}
