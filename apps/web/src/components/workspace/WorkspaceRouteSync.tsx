import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { useFocusedWorkspaceRouteTarget, useWorkspaceStore } from "../../workspace/store";
import type { ThreadSurfaceInput } from "../../workspace/types";

function sameRouteTarget(
  left: ReturnType<typeof resolveThreadRouteTarget>,
  right: ReturnType<typeof resolveThreadRouteTarget>,
): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right || left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "server" && right.kind === "server") {
    return (
      left.threadRef.environmentId === right.threadRef.environmentId &&
      left.threadRef.threadId === right.threadRef.threadId
    );
  }
  if (left.kind === "draft" && right.kind === "draft") {
    return left.draftId === right.draftId;
  }
  return false;
}

export function WorkspaceRouteSync() {
  const navigate = useNavigate();
  const openThreadSurface = useWorkspaceStore((state) => state.openThreadSurface);
  const currentRouteTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const focusedRouteTarget = useFocusedWorkspaceRouteTarget();
  const pathname = useLocation({
    select: (location) => location.pathname,
  });
  const previousPathnameRef = useRef(pathname);
  const draftSession = useComposerDraftStore((store) =>
    currentRouteTarget?.kind === "draft" ? store.getDraftSession(currentRouteTarget.draftId) : null,
  );
  const currentRouteSurfaceInput = useMemo<ThreadSurfaceInput | null>(() => {
    if (!currentRouteTarget) {
      return null;
    }
    if (currentRouteTarget.kind === "server") {
      return {
        scope: "server",
        threadRef: currentRouteTarget.threadRef,
      };
    }
    if (!draftSession) {
      return null;
    }
    return {
      scope: "draft",
      draftId: currentRouteTarget.draftId,
      environmentId: draftSession.environmentId,
      threadId: draftSession.threadId,
    };
  }, [currentRouteTarget, draftSession]);

  useEffect(() => {
    const pathnameChanged = previousPathnameRef.current !== pathname;
    previousPathnameRef.current = pathname;

    if (currentRouteTarget) {
      if (!currentRouteSurfaceInput) {
        return;
      }

      if (!focusedRouteTarget || pathnameChanged) {
        openThreadSurface(currentRouteSurfaceInput, "focus-or-tab");
        return;
      }

      if (sameRouteTarget(currentRouteTarget, focusedRouteTarget)) {
        return;
      }

      void navigateToRouteTarget(navigate, focusedRouteTarget);
      return;
    }

    if (!focusedRouteTarget) {
      return;
    }

    void navigateToRouteTarget(navigate, focusedRouteTarget);
  }, [
    currentRouteSurfaceInput,
    currentRouteTarget,
    focusedRouteTarget,
    navigate,
    openThreadSurface,
    pathname,
  ]);

  return null;
}

function navigateToRouteTarget(
  navigate: ReturnType<typeof useNavigate>,
  target: NonNullable<ReturnType<typeof resolveThreadRouteTarget>>,
) {
  if (target.kind === "server") {
    return navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId: target.threadRef.environmentId,
        threadId: target.threadRef.threadId,
      },
      replace: true,
      search: {},
    });
  }

  return navigate({
    to: "/draft/$draftId",
    params: {
      draftId: target.draftId,
    },
    replace: true,
    search: {},
  });
}
