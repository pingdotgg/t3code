import type { ScopedThreadRef } from "@t3tools/contracts";
import { useMatches, useParams } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";

import {
  getAppModalReturnTarget,
  isAppModalPage,
  subscribeAppModalReturnTarget,
} from "../components/sidebar/mainAppLocation";
import {
  resolveThreadRouteRef,
  resolveThreadRouteTarget,
  type ThreadRouteTarget,
} from "../threadRoutes";

function useThreadRouteIds() {
  const environmentId = useParams({ strict: false, select: (params) => params.environmentId });
  const threadId = useParams({ strict: false, select: (params) => params.threadId });
  return { environmentId, threadId };
}

export function useThreadRouteTarget(): ThreadRouteTarget | null {
  const { environmentId, threadId } = useThreadRouteIds();
  const draftId = useParams({ strict: false, select: (params) => params.draftId });
  return resolveThreadRouteTarget({ environmentId, threadId, draftId });
}

/** The thread on screen: while Settings or Usage is open, the one behind it. */
export function useShownThreadRouteTarget(): {
  target: ThreadRouteTarget | null;
  modalOpen: boolean;
} {
  const routeTarget = useThreadRouteTarget();
  // Read matches, not location, so this agrees with the params useThreadRouteTarget reads.
  const modalOpen = useMatches({
    select: (matches) => matches.some((match) => isAppModalPage(match.pathname)),
  });
  // Kept at router level so consumers that remount under the modal still agree.
  // Read only while a modal is open, so thread changes do not re-render consumers twice.
  const backgroundTarget = useSyncExternalStore(subscribeAppModalReturnTarget, () =>
    modalOpen ? getAppModalReturnTarget() : null,
  );
  return { target: modalOpen ? backgroundTarget : routeTarget, modalOpen };
}

export function useThreadRouteRef(): ScopedThreadRef | null {
  return resolveThreadRouteRef(useThreadRouteIds());
}
