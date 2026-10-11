import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom } from "./preferences";
import {
  DEFAULT_MOBILE_PROJECT_GROUPING_SETTINGS,
  resolveMobileProjectGroupingSettings,
} from "./project-grouping.logic";

export * from "./project-grouping.logic";

export function useMobileProjectGroupingSettings() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const mode = AsyncResult.isSuccess(preferencesResult)
    ? resolveMobileProjectGroupingSettings(preferencesResult.value).sidebarProjectGroupingMode
    : DEFAULT_MOBILE_PROJECT_GROUPING_SETTINGS.sidebarProjectGroupingMode;
  return useMemo(
    () => ({
      sidebarProjectGroupingMode: mode,
      sidebarProjectGroupingOverrides:
        DEFAULT_MOBILE_PROJECT_GROUPING_SETTINGS.sidebarProjectGroupingOverrides,
    }),
    [mode],
  );
}
