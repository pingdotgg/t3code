import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";

import { hasUnseenCompletion } from "~/components/Sidebar.logic";
import { useThreadShells } from "~/state/entities";
import { resolveThreadRouteTarget } from "~/threadRoutes";
import { useUiStateStore } from "~/uiStateStore";

const APP_SESSION_STARTED_AT_MS = Date.now();

export function isThreadUnreadBackground(
  thread: EnvironmentThreadShell,
  lastVisitedAt: string | undefined,
  currentRouteThreadKey: string | null,
  sessionStartedAtMs: number = APP_SESSION_STARTED_AT_MS,
): boolean {
  if (thread.archivedAt !== null) return false;
  const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  if (threadKey === currentRouteThreadKey) return false;

  if (hasUnseenCompletion({ ...thread, lastVisitedAt })) {
    return true;
  }

  if (lastVisitedAt === undefined && thread.latestTurn?.completedAt) {
    const completedAtMs = Date.parse(thread.latestTurn.completedAt);
    if (!Number.isNaN(completedAtMs) && completedAtMs >= sessionStartedAtMs) {
      return true;
    }
  }

  return false;
}

export function countUnreadBackgroundThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  threadLastVisitedAtById: Readonly<Record<string, string>>,
  currentRouteThreadKey: string | null,
  sessionStartedAtMs: number = APP_SESSION_STARTED_AT_MS,
): number {
  let count = 0;
  for (const thread of threads) {
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const lastVisitedAt = threadLastVisitedAtById[threadKey];
    if (
      isThreadUnreadBackground(thread, lastVisitedAt, currentRouteThreadKey, sessionStartedAtMs)
    ) {
      count++;
    }
  }
  return count;
}

export function useUnreadBackgroundThreadCount(): number {
  const threads = useThreadShells();
  const threadLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });

  const currentRouteThreadKey = useMemo(() => {
    if (routeTarget?.kind === "server") {
      return scopedThreadKey(routeTarget.threadRef);
    }
    return null;
  }, [routeTarget]);

  return useMemo(
    () => countUnreadBackgroundThreads(threads, threadLastVisitedAtById, currentRouteThreadKey),
    [threads, threadLastVisitedAtById, currentRouteThreadKey],
  );
}
