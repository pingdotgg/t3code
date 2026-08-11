import { useMemo } from "react";
import { useParams } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useComposerDraftStore } from "~/composerDraftStore";
import { resolveThreadRouteTarget } from "~/threadRoutes";

/**
 * The thread the user is currently looking at, or null anywhere else in the
 * app (settings, pull requests, the thread list). A draft resolves to the
 * server thread it was promoted into, so surfaces that key off "is this thread
 * on screen" keep working across the promotion.
 */
export function useActiveThreadRefFromRoute(): ScopedThreadRef | null {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const activeDraftSession = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );

  return useMemo(() => {
    if (routeTarget?.kind === "server") {
      return routeTarget.threadRef;
    }
    if (routeTarget?.kind === "draft" && activeDraftSession) {
      return {
        environmentId: activeDraftSession.environmentId,
        threadId: activeDraftSession.threadId,
      };
    }
    return null;
  }, [activeDraftSession, routeTarget]);
}
