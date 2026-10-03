import { type ChatSplitDropPlacement, diffRouteStatesEqual } from "../chatSplitLayout";
import type { DiffRouteSearch } from "../diffRouteSearch";
import { threadRouteTargetsEqual, type ThreadRouteTarget } from "../threadRoutes";

export function resolveChatPaneRenderMode(params: {
  isFocused: boolean;
  target: ThreadRouteTarget;
}): "live" | "empty" {
  // Both server threads and (client-only) draft threads render a live chat
  // surface; drafts promote to server threads in place on first send.
  if (params.target.kind !== "server" && params.target.kind !== "draft") {
    return "empty";
  }
  return "live";
}

export function shouldSyncFocusedLeafToRoute(params: {
  focusedLeafTarget: ThreadRouteTarget | null;
  focusedLeafDiff: DiffRouteSearch | null;
  routeTarget: ThreadRouteTarget;
  routeDiffSearch?: DiffRouteSearch;
}): boolean {
  const { focusedLeafTarget, focusedLeafDiff, routeTarget, routeDiffSearch } = params;
  if (!focusedLeafTarget) return false;
  if (!threadRouteTargetsEqual(focusedLeafTarget, routeTarget)) return true;
  if (focusedLeafTarget.kind !== "server" || routeTarget.kind !== "server") return false;
  return !diffRouteStatesEqual(focusedLeafDiff, routeDiffSearch);
}

interface ChatSplitDropRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function resolveChatSplitDropPlacement(params: {
  readonly rect: ChatSplitDropRect;
  readonly clientX: number;
  readonly clientY: number;
}): ChatSplitDropPlacement {
  const { rect, clientX, clientY } = params;
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const distances = [
    { placement: "left" as const, distance: x },
    { placement: "right" as const, distance: rect.width - x },
    { placement: "top" as const, distance: y },
    { placement: "bottom" as const, distance: rect.height - y },
  ];
  return distances.reduce((best, next) => (next.distance < best.distance ? next : best)).placement;
}
