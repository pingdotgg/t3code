import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { mobilePreferencesAtom } from "./preferences";
import {
  DEFAULT_MOBILE_PROJECT_GROUPING_SETTINGS,
  resolveMobileProjectGroupingSettings,
} from "./project-grouping.logic";

export * from "./project-grouping.logic";

export function useMobileProjectGroupingSettings() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferencesResult)
    ? resolveMobileProjectGroupingSettings(preferencesResult.value)
    : DEFAULT_MOBILE_PROJECT_GROUPING_SETTINGS;
}
