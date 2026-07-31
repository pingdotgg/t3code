import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import type { Preferences } from "../persistence/mobile-preferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "./preferences";
import { markThreadVisited } from "./thread-visits.logic";

export { resolveOpenThreadVisitedAt, shouldMarkThreadVisited } from "./thread-visits.logic";

const EMPTY_VISITS: Readonly<Record<string, string>> = {};

export function useThreadVisits(): {
  readonly lastVisitedAtByThreadKey: Readonly<Record<string, string>>;
  readonly markVisited: (threadKey: string, visitedAt: string) => void;
} {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const lastVisitedAtByThreadKey = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.threadLastVisitedAtById ?? EMPTY_VISITS)
    : EMPTY_VISITS;

  const markVisited = useCallback(
    (threadKey: string, visitedAt: string) => {
      savePreferences((current: Preferences) => {
        const visits = current.threadLastVisitedAtById ?? EMPTY_VISITS;
        const next = markThreadVisited(visits, threadKey, visitedAt);
        return next === visits ? {} : { threadLastVisitedAtById: next };
      });
    },
    [savePreferences],
  );

  return { lastVisitedAtByThreadKey, markVisited };
}
