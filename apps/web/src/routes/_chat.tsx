import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { Outlet, createFileRoute, redirect, useMatches } from "@tanstack/react-router";
import { useLayoutEffect, useState } from "react";

import { ThreadRouteView } from "../components/ThreadRouteView";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { SidebarInset } from "../components/ui/sidebar";
import { resolveThreadRouteTarget, type ThreadRouteTarget } from "../threadRoutes";
import { retainThreadFindForRoute } from "../components/chat/threadFindStore";
import { ThreadLinkPrompt } from "../components/promptLinks/ThreadLinkPrompt";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { PaneAddDropZone } from "../components/panes/PaneAddDropZone";
import { PaneGrid } from "../components/panes/PaneGrid";
import { isSplitLayout } from "../paneLayout";
import { usePaneLayoutStore } from "../paneLayoutStore";

function threadRouteTargetKey(target: ThreadRouteTarget | null) {
  if (!target) return null;
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : target.draftId;
}

function ChatRouteLayout() {
  // Render both routes here so draft promotion keeps the same ChatView mounted.
  const threadTarget = useThreadRouteTarget();
  // Read matches, not location, so this agrees with the params useThreadRouteTarget reads.
  const modalOpen = useMatches({
    select: (matches) => matches.some((match) => isAppModalPage(match.pathname)),
  });
  // Settings and Usage render over the thread that opened them, so ChatView never remounts.
  const [backgroundTarget, setBackgroundTarget] = useState(threadTarget);
  if (!modalOpen && threadRouteTargetKey(backgroundTarget) !== threadRouteTargetKey(threadTarget)) {
    setBackgroundTarget(threadTarget);
  }
  const shownTarget = modalOpen ? backgroundTarget : threadTarget;
  // Split view needs room for side-by-side conversations; a narrow window shows one thread.
  const roomForPanes = !useMediaQuery("max-md");
  const splitActive = usePaneLayoutStore(isSplitLayout) && roomForPanes;
  const routeThreadKey =
    shownTarget?.kind === "server" ? scopedThreadKey(shownTarget.threadRef) : null;
  // Keep the panes in step with the route. Layout effect, so the grid never paints a stale pane.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the route's thread into the persisted pane layout
  useLayoutEffect(() => {
    if (routeThreadKey === null || modalOpen) return;
    usePaneLayoutStore.getState().followRoute(parseScopedThreadKey(routeThreadKey)!);
  }, [modalOpen, routeThreadKey]);
  return (
    <>
      {shownTarget?.kind === "server" && !modalOpen ? (
        <ThreadLinkPrompt threadRef={shownTarget.threadRef} />
      ) : null}
      {roomForPanes && !modalOpen ? (
        <PaneAddDropZone current={shownTarget?.kind === "server" ? shownTarget.threadRef : null} />
      ) : null}
      {shownTarget && splitActive ? (
        <PaneGrid routeTarget={shownTarget} background={modalOpen} />
      ) : shownTarget ? (
        <ThreadRouteView target={shownTarget} background={modalOpen} />
      ) : modalOpen ? (
        <SidebarInset className="h-dvh" />
      ) : (
        <Outlet />
      )}
      {modalOpen ? <Outlet /> : null}
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
    return { appModalPage: isAppModalPage(location.pathname) };
  },
  component: ChatRouteLayout,
  // Every match carries the whole location's params, so this layout sees the thread route's too.
  onEnter: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onStay: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onLeave: () => retainThreadFindForRoute({ modalPage: false, threadRef: null }),
});

function retainThreadFindForRouteMatch(
  modalPage: boolean,
  params: Partial<Record<"environmentId" | "threadId", string>>,
) {
  const target = resolveThreadRouteTarget(params);
  retainThreadFindForRoute({
    modalPage,
    threadRef: target?.kind === "server" ? target.threadRef : null,
  });
}
