import { useNavigate, useRouter } from "@tanstack/react-router";
import { Fragment, useEffect } from "react";

import { resolveChatPanes, useChatPanesStore, type ResolvedChatPane } from "../chatPanesStore";
import { ComposerHandleContext, useComposerHandleContext } from "../composerHandleContext";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { cn } from "../lib/utils";
import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  isThreadRoutePathname,
  type ThreadRouteTarget,
} from "../threadRoutes";
import { ThreadRouteContent } from "./ThreadRouteView";
import { Button } from "./ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";

/** Threads side by side. The route shows the focused pane, so focusing a pane navigates to it. */
export function ChatPanes({
  routeTarget,
  background,
}: {
  routeTarget: ThreadRouteTarget;
  background: boolean;
}) {
  const router = useRouter();
  const navigate = useNavigate();
  const layout = useChatPanesStore((state) => state.layout);
  const panes = resolveChatPanes(layout, routeTarget);
  const singlePaneViewport = useMediaQuery("max-sm");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the routed thread into the persisted pane layout
  useEffect(() => {
    if (!background) useChatPanesStore.getState().commit(routeTarget);
  }, [background, routeTarget]);

  const focusPane = (target: ThreadRouteTarget) => {
    // A pointerdown and the focus it causes both land here before the route re-renders.
    if (isRouteFor(router.latestLocation.pathname, target)) return;
    void (target.kind === "server"
      ? navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(target.threadRef),
        })
      : navigate({ to: "/draft/$draftId", params: buildDraftThreadRouteParams(target.draftId) }));
  };
  const closePane = (paneId: string) => {
    const focusTarget = useChatPanesStore.getState().closePane(paneId);
    if (focusTarget) focusPane(focusTarget);
  };

  return (
    <SidebarInset
      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
      inert={background}
      data-background-thread-view={background || undefined}
    >
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1",
          layout.direction === "column" ? "flex-col" : "flex-row",
        )}
      >
        {panes.map((pane, index) =>
          singlePaneViewport && !pane.active ? null : (
            <Fragment key={pane.id}>
              {index > 0 && !singlePaneViewport ? (
                <div
                  aria-hidden
                  className={cn(
                    "shrink-0 bg-border",
                    layout.direction === "column" ? "h-px w-full" : "h-full w-px",
                  )}
                />
              ) : null}
              <ChatPane
                pane={pane}
                background={background}
                onFocus={() => focusPane(pane.target)}
                onClose={() => closePane(pane.id)}
              />
            </Fragment>
          ),
        )}
      </div>
    </SidebarInset>
  );
}

function isRouteFor(pathname: string, target: ThreadRouteTarget): boolean {
  return target.kind === "server"
    ? isThreadRoutePathname(pathname, target.threadRef)
    : pathname.replace(/\/$/, "") === `/draft/${target.draftId}`;
}

function ChatPane({
  pane,
  background,
  onFocus,
  onClose,
}: {
  pane: ResolvedChatPane;
  background: boolean;
  onFocus: () => void;
  onClose: () => void;
}) {
  const composerHandle = useComposerHandleContext();
  const passive = !pane.active;
  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 basis-0 flex-col"
      data-chat-pane={pane.id}
      data-background-thread-view={passive || undefined}
      onPointerDownCapture={passive ? onFocus : undefined}
      onFocusCapture={passive ? onFocus : undefined}
    >
      {/* The app-wide composer handle belongs to the focused pane's composer. */}
      <ComposerHandleContext value={passive ? null : composerHandle}>
        <ThreadRouteContent
          target={pane.target}
          background={background}
          passive={passive}
          unavailable={<UnavailablePane onClose={onClose} />}
        />
      </ComposerHandleContext>
    </div>
  );
}

function UnavailablePane({ onClose }: { onClose: () => void }) {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>Thread unavailable</EmptyTitle>
        <EmptyDescription>It was deleted, archived, or is hidden by a filter.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" size="sm" onClick={onClose}>
          Close pane
        </Button>
      </EmptyContent>
    </Empty>
  );
}
