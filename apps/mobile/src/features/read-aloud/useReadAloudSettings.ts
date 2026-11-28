import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_READ_ALOUD_SETTINGS } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { mobilePreferencesAtom } from "../../state/preferences";

/** The saved read-aloud settings, or the defaults until preferences load. */
export function useReadAloudSettings() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? (preferences.value.readAloud ?? DEFAULT_READ_ALOUD_SETTINGS)
    : DEFAULT_READ_ALOUD_SETTINGS;
}
