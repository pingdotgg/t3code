import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftRightIcon, XIcon } from "lucide-react";
import { useRef, type PointerEvent } from "react";

import { ComposerHandleContext } from "../../composerHandleContext";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { useQuietThreadShell } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useWorkspaceTabsStore } from "../../workspaceTabsStore";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { Button } from "../ui/button";

/**
 * A second thread beside the route's thread. It runs like a side chat: its global shortcuts stand
 * down, and anything that needs a panel or terminal swaps it into the main view.
 */
export function WorkspaceSplitPane({
  splitKey,
  activeKey,
  ratio,
}: {
  readonly splitKey: string;
  readonly activeKey: string;
  readonly ratio: number;
}) {
  const navigate = useNavigate();
  const ref = parseScopedThreadKey(splitKey);
  const shell = useQuietThreadShell(ref);
  const paneRef = useRef<HTMLDivElement>(null);
  if (ref === null) return null;

  const swap = () => {
    useWorkspaceTabsStore.getState().openSplit(activeKey, splitKey);
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  };
  const parentPanel: SideChatParentPanel = { openToolDiff: swap, runShellCommand: swap };

  const resize = (event: PointerEvent<HTMLDivElement>) => {
    const container = paneRef.current?.parentElement;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    useWorkspaceTabsStore
      .getState()
      .setSplitRatio((bounds.right - event.clientX) / Math.max(bounds.width, 1));
  };

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize split view"
        className="w-1 shrink-0 cursor-col-resize bg-border/60 hover:bg-ring/60"
        onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event);
        }}
      />
      <div
        ref={paneRef}
        data-side-chat-pane={splitKey}
        data-workspace-split-pane
        className="flex min-h-0 min-w-0 flex-col"
        style={{ flexBasis: `${ratio * 100}%` }}
      >
        {/* The main thread's panel controls sit fixed at the window's top right, over this row. */}
        <div className="flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 ps-3 pe-(--workspace-split-header-end)">
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {shell?.title.trim() || "Thread"}
          </span>
          <Button variant="ghost" size="icon-xs" aria-label="Swap with main thread" onClick={swap}>
            <ArrowLeftRightIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Close split view"
            onClick={() => useWorkspaceTabsStore.getState().closeSplit()}
          >
            <XIcon />
          </Button>
        </div>
        <BackgroundThreadContext value>
          <ComposerHandleContext value={null}>
            <ChatView
              environmentId={ref.environmentId}
              threadId={ref.threadId}
              routeKind="server"
              embedded={parentPanel}
            />
          </ComposerHandleContext>
        </BackgroundThreadContext>
      </div>
    </>
  );
}
