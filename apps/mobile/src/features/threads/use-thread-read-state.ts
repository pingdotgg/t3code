import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  hasUnseenThreadCompletion,
  resolveThreadUnreadAt,
  resolveThreadVisitedAt,
} from "@t3tools/client-runtime/state/thread-read-state";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useCallback } from "react";

import { scopedThreadKey } from "../../lib/scopedEntities";
import type { Preferences } from "../../persistence/mobile-preferences";
import {
  mobileThreadLastVisitedAtAtom,
  updateMobilePreferencesAtom,
} from "../../state/preferences";

export function useThreadReadState(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "latestTurn">,
) {
  const threadKey = scopedThreadKey(thread.environmentId, thread.id);
  const visitedMarker = useAtomValue(mobileThreadLastVisitedAtAtom(threadKey));
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = visitedMarker !== null;
  const lastVisitedAt = typeof visitedMarker === "string" ? visitedMarker : undefined;

  const markThreadUnread = useCallback(() => {
    if (!preferencesReady) return;
    const unreadAt = resolveThreadUnreadAt(thread.latestTurn?.completedAt);
    if (unreadAt !== undefined && unreadAt !== lastVisitedAt) {
      savePreferences((preferences: Preferences) => ({
        threadLastVisitedAtById: {
          ...preferences.threadLastVisitedAtById,
          [threadKey]: unreadAt,
        },
      }));
    }
  }, [lastVisitedAt, preferencesReady, savePreferences, thread.latestTurn?.completedAt, threadKey]);

  const markThreadVisited = useCallback(() => {
    if (!preferencesReady) return;
    // A thread visited mid-turn has no completion to anchor to yet; stamp
    // the visit time so a later completion still reads as unseen.
    const visitedAt = resolveThreadVisitedAt(
      lastVisitedAt,
      thread.latestTurn?.completedAt ?? new Date().toISOString(),
    );
    if (visitedAt !== undefined && visitedAt !== lastVisitedAt) {
      savePreferences((preferences: Preferences) => ({
        threadLastVisitedAtById: {
          ...preferences.threadLastVisitedAtById,
          [threadKey]: visitedAt,
        },
      }));
    }
  }, [lastVisitedAt, preferencesReady, savePreferences, thread.latestTurn?.completedAt, threadKey]);

  return {
    isUnread: hasUnseenThreadCompletion(thread, lastVisitedAt),
    markThreadUnread,
    markThreadVisited,
  } as const;
}
