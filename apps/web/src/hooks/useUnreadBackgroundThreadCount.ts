import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";

import { hasUnseenCompletion } from "~/components/Sidebar.logic";
import { useThreadShells } from "~/state/entities";
import { resolveThreadRouteTarget } from "~/threadRoutes";
import { useUiStateStore } from "~/uiStateStore";

export function isThreadUnreadBackground(
  thread: EnvironmentThreadShell,
  lastVisitedAt: string | undefined,
  currentRouteThreadKey: string | null,
): boolean {
  if (thread.archivedAt !== null) return false;
  const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  if (threadKey === currentRouteThreadKey) return false;

  return hasUnseenCompletion({ ...thread, lastVisitedAt });
}

export function countUnreadBackgroundThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  threadLastVisitedAtById: Readonly<Record<string, string>>,
  currentRouteThreadKey: string | null,
): number {
  let count = 0;
  for (const thread of threads) {
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const lastVisitedAt = threadLastVisitedAtById[threadKey];
    if (isThreadUnreadBackground(thread, lastVisitedAt, currentRouteThreadKey)) {
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
