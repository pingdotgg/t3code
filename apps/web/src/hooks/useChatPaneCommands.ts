import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";

import { isChatSplitOpen, useChatPanesStore } from "../chatPanesStore";
import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  resolveThreadRouteTarget,
  type ThreadRouteTarget,
} from "../threadRoutes";
import { useStableCallback } from "./useStableCallback";

/**
 * Split pane actions for entry points outside the panes: the sidebar, the command palette and
 * shortcuts. The route shows the focused pane, so each focus change is a navigation.
 */
export function useChatPaneCommands() {
  const router = useRouter();
  const readRouteTarget = () => resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const navigateTo = (target: ThreadRouteTarget) =>
    void (target.kind === "server"
      ? router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(target.threadRef),
        })
      : router.navigate({
          to: "/draft/$draftId",
          params: buildDraftThreadRouteParams(target.draftId),
        }));

  /** Opens `threadRef` beside the routed thread and focuses it; false with no thread routed. */
  const openInSplit = useStableCallback((threadRef: ScopedThreadRef): boolean => {
    const routeTarget = readRouteTarget();
    if (routeTarget === null) return false;
    useChatPanesStore.getState().openSplit({ routeTarget, target: { kind: "server", threadRef } });
    navigateTo({ kind: "server", threadRef });
    return true;
  });

  const focusOtherPane = useStableCallback(() => {
    const { layout } = useChatPanesStore.getState();
    const other = layout.panes.find((pane) => pane.id !== layout.activePaneId);
    if (isChatSplitOpen(layout) && other) navigateTo(other.target);
  });

  const closeFocusedPane = useStableCallback(() => {
    const store = useChatPanesStore.getState();
    const { activePaneId } = store.layout;
    if (activePaneId === null) return;
    const focusTarget = store.closePane(activePaneId);
    if (focusTarget) navigateTo(focusTarget);
  });

  return { openInSplit, focusOtherPane, closeFocusedPane };
}
