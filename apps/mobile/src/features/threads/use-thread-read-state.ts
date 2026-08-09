import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  mobilePreferencesAtom,
  mobileThreadLastVisitedAtAtom,
  updateMobilePreferencesAtom,
} from "../../state/preferences";
import {
  hasUnseenThreadCompletion,
  setThreadUnreadAt,
  setThreadVisitedAt,
} from "./thread-read-state";

function currentVisitedAtById() {
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? (preferences.value.threadLastVisitedAtById ?? {})
    : null;
}

export function useThreadReadState(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "latestTurn">,
) {
  const threadKey = scopedThreadKey(thread.environmentId, thread.id);
  const visitedMarker = useAtomValue(mobileThreadLastVisitedAtAtom(threadKey));
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = visitedMarker !== null;
  const lastVisitedAt = typeof visitedMarker === "string" ? visitedMarker : undefined;

  const markThreadUnread = useCallback(() => {
    const current = currentVisitedAtById();
    if (!preferencesReady || current === null) return;
    const next = setThreadUnreadAt(current, threadKey, thread.latestTurn?.completedAt);
    if (next !== current) savePreferences({ threadLastVisitedAtById: next });
  }, [preferencesReady, savePreferences, thread.latestTurn?.completedAt, threadKey]);

  const markThreadVisited = useCallback(() => {
    const current = currentVisitedAtById();
    if (!preferencesReady || current === null) return;
    const next = setThreadVisitedAt(current, threadKey, thread.latestTurn?.completedAt);
    if (next !== current) savePreferences({ threadLastVisitedAtById: next });
  }, [preferencesReady, savePreferences, thread.latestTurn?.completedAt, threadKey]);

  return {
    isUnread: hasUnseenThreadCompletion(thread, lastVisitedAt),
    markThreadUnread,
    markThreadVisited,
  } as const;
}
