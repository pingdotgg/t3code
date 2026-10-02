import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/unstable/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";

/** Read this client's display direction, using the shared default until preferences are available. */
export function useUsageLimitDisplayMode() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return (
    (AsyncResult.isSuccess(preferences) ? preferences.value.usageLimitDisplayMode : undefined) ??
    DEFAULT_CLIENT_SETTINGS.usageLimitDisplayMode
  );
}
