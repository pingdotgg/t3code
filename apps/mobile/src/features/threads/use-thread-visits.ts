import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  withThreadVisited,
  type ThreadVisitsById,
} from "@t3tools/client-runtime/state/thread-status";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

const NO_VISITS: ThreadVisitsById = {};

/** Device-local last-visited stamps that clear the thread list's Done label. */
export function useThreadLastVisitedAtById(): ThreadVisitsById {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.threadLastVisitedAtById ?? NO_VISITS)
    : NO_VISITS;
}

/** Stamps a visit at the completion the reader is looking at. Never moves a stamp backwards. */
export function useMarkThreadVisited(): (threadKey: string, visitedAt: string) => void {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  return useCallback(
    (threadKey, visitedAt) => {
      savePreferences({
        transform: (current) => {
          const visits = current.threadLastVisitedAtById ?? NO_VISITS;
          const next = withThreadVisited(visits, threadKey, visitedAt);
          return next === visits ? {} : { threadLastVisitedAtById: next };
        },
      });
    },
    [savePreferences],
  );
}
