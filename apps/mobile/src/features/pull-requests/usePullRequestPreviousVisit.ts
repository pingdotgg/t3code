import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { Preferences } from "../../persistence/mobile-preferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { pullRequestReviewKey } from "./pullRequestReviewDrafts";
import type { PullRequestParams } from "./usePullRequestDiff";

function visitedNow(key: string) {
  const at = new Date().toISOString();
  return (current: Preferences) => ({
    pullRequestVisits: Object.fromEntries(
      [
        ...Object.entries(current.pullRequestVisits ?? {}).filter(([id]) => id !== key),
        [key, at],
      ].slice(-256),
    ),
  });
}

/**
 * The visit before this one, held for as long as the pull request stays open. Once its activity
 * shows, the visit is recorded, and again when the reader leaves or backgrounds the app.
 */
export function usePullRequestPreviousVisit(params: PullRequestParams, activityLoaded: boolean) {
  const key = pullRequestReviewKey(params);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const [visit, setVisit] = useState<{ key: string; at: string | null } | null>(null);
  const seenKey = useRef<string | null>(null);
  if (visit?.key !== key && AsyncResult.isSuccess(preferences))
    setVisit({ key, at: preferences.value.pullRequestVisits?.[key] ?? null });
  const ready = activityLoaded && visit?.key === key;
  useEffect(() => {
    if (!ready || seenKey.current === key) return;
    seenKey.current = key;
    save({ transform: visitedNow(key) });
  }, [ready, key, save]);
  useEffect(() => {
    const leave = () => {
      if (seenKey.current === key) save({ transform: visitedNow(key) });
    };
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") leave();
    });
    return () => {
      subscription.remove();
      leave();
    };
  }, [key, save]);
  return visit?.key === key ? visit.at : null;
}
