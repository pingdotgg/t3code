import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { Maximize2Icon, XIcon } from "lucide-react";
import {
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { useDiffPanelStore } from "../../diffPanelStore";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentShellHasSnapshot } from "../../state/shell";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { isAppModalPage } from "../sidebar/mainAppLocation";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { snapSplitRatio, useWorkspaceTabsStore } from "./workspaceTabsStore";

/** Routes `ref` into the main pane; the thread it replaces takes the split pane. */
export function useShowThreadInMain() {
  const navigate = useNavigate();
  const routeTarget = useThreadRouteTarget();
  const activeKey = routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;
  return (ref: ScopedThreadRef) => {
    const { split, setSplitKey, closeSplit } = useWorkspaceTabsStore.getState();
    if (split?.key === scopedThreadKey(ref)) {
      if (activeKey) setSplitKey(activeKey);
      else closeSplit();
    }
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  };
}

/** The routed thread, plus an optional second thread beside or under it with a snapping handle. */
export function WorkspaceSplit({ children }: { children: ReactNode }) {
  const split = useWorkspaceTabsStore((state) => state.split);
  const setSplitRatio = useWorkspaceTabsStore((state) => state.setSplitRatio);
  const routeTarget = useThreadRouteTarget();
  const modalOpen = useLocation({ select: (location) => isAppModalPage(location.pathname) });
  const containerRef = useRef<HTMLDivElement>(null);
  const activeKey = routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;
  const shown = split !== null && split.key !== activeKey && !modalOpen ? split : null;
  const vertical = shown?.direction === "down";

  // Drags write the ratio straight to the DOM so neither chat re-renders; the store gets the drop.
  const preview = (event: PointerEvent<HTMLElement>) => {
    const container = containerRef.current;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    const size = vertical ? rect.height : rect.width;
    const offset = vertical ? event.clientY - rect.top : event.clientX - rect.left;
    const { ratio, snapped } = snapSplitRatio(offset / size, size);
    container.style.setProperty("--split-ratio", String(ratio));
    event.currentTarget.dataset.snapped = String(snapped);
    return ratio;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!shown) return;
    const step = { ArrowLeft: -0.05, ArrowUp: -0.05, ArrowRight: 0.05, ArrowDown: 0.05 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    setSplitRatio(shown.ratio + step);
  };

  return (
    <div
      ref={containerRef}
      className={cn("flex min-h-0 min-w-0 flex-1", vertical ? "flex-col" : "flex-row")}
      style={shown ? ({ "--split-ratio": String(shown.ratio) } as CSSProperties) : undefined}
    >
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col md:grow-(--split-ratio)"
        style={shown ? undefined : { flexGrow: 1 }}
      >
        {children}
      </div>
      {shown ? (
        <>
          <div
            role="separator"
            tabIndex={0}
            aria-label="Resize split"
            aria-orientation={vertical ? "horizontal" : "vertical"}
            aria-valuenow={Math.round(shown.ratio * 100)}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              preview(event);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) preview(event);
            }}
            onPointerUp={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              const ratio = preview(event);
              if (ratio !== null) setSplitRatio(ratio);
              event.currentTarget.dataset.snapped = "false";
            }}
            onDoubleClick={() => setSplitRatio(0.5)}
            onKeyDown={onKeyDown}
            className={cn(
              "group/sash relative hidden shrink-0 touch-none outline-hidden md:flex",
              vertical ? "h-1.5 cursor-row-resize" : "w-1.5 cursor-col-resize",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "absolute rounded-full group-hover/sash:bg-foreground/15 group-focus-visible/sash:bg-ring group-data-[snapped=true]/sash:bg-primary",
                vertical ? "inset-x-0 top-[2px] h-0.5" : "inset-y-0 left-[2px] w-0.5",
              )}
            />
          </div>
          <div className="hidden min-h-0 min-w-0 basis-0 grow-[calc(1_-_var(--split-ratio))] flex-col md:flex">
            <WorkspaceSplitPane splitKey={shown.key} />
          </div>
        </>
      ) : null}
    </div>
  );
}

function WorkspaceSplitPane({ splitKey }: { splitKey: string }) {
  const threadRef = parseScopedThreadKey(splitKey);
  const shell = useQuietThreadShell(threadRef);
  const snapshotLoaded = useEnvironmentShellHasSnapshot(threadRef?.environmentId ?? null);
  const closeSplit = useWorkspaceTabsStore((state) => state.closeSplit);
  const showThreadInMain = useShowThreadInMain();
  // The embedded pane has no panel or terminal drawer, so those open with it in the main pane.
  const parentPanel: SideChatParentPanel | null = threadRef && {
    openToolDiff: (target) => {
      useDiffPanelStore.getState().selectToolCall(threadRef, target);
      useRightPanelStore.getState().open(threadRef, "diff");
      showThreadInMain(threadRef);
    },
    // ponytail: moves the thread to the main pane without running it; run it there.
    runShellCommand: () => showThreadInMain(threadRef),
  };

  return (
    <SidebarInset data-side-chat-pane className="min-h-0 overflow-hidden">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {shell?.title ?? "Thread"}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Open in main pane"
          disabled={!threadRef}
          onClick={() => threadRef && showThreadInMain(threadRef)}
        >
          <Maximize2Icon />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Close split" onClick={closeSplit}>
          <XIcon />
        </Button>
      </div>
      {threadRef && parentPanel && shell !== null ? (
        <BackgroundThreadContext value>
          <ChatView
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            routeKind="server"
            embedded={parentPanel}
          />
        </BackgroundThreadContext>
      ) : snapshotLoaded ? (
        <p className="p-3 text-xs text-muted-foreground">This thread is no longer available.</p>
      ) : null}
    </SidebarInset>
  );
}
