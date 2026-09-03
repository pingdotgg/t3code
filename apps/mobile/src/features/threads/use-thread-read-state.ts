import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  hasUnseenThreadCompletion,
  resolveThreadUnreadAt,
  resolveThreadVisitedAt,
} from "@t3tools/client-runtime/state/thread-read-state";
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
    const unreadAt = resolveThreadUnreadAt(thread.latestTurn?.completedAt);
    if (unreadAt !== undefined && unreadAt !== current[threadKey]) {
      savePreferences({ threadLastVisitedAtById: { ...current, [threadKey]: unreadAt } });
    }
  }, [preferencesReady, savePreferences, thread.latestTurn?.completedAt, threadKey]);

  const markThreadVisited = useCallback(() => {
    const current = currentVisitedAtById();
    if (!preferencesReady || current === null) return;
    // A thread visited mid-turn has no completion to anchor to yet; stamp
    // the visit time so a later completion still reads as unseen.
    const visitedAt = resolveThreadVisitedAt(
      current[threadKey],
      thread.latestTurn?.completedAt ?? new Date().toISOString(),
    );
    if (visitedAt !== undefined && visitedAt !== current[threadKey]) {
      savePreferences({ threadLastVisitedAtById: { ...current, [threadKey]: visitedAt } });
    }
  }, [preferencesReady, savePreferences, thread.latestTurn?.completedAt, threadKey]);

  return {
    isUnread: hasUnseenThreadCompletion(thread, lastVisitedAt),
    markThreadUnread,
    markThreadVisited,
  } as const;
}
