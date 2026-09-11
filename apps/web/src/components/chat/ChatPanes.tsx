import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { GripVerticalIcon, XIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  collectLeaves,
  findLeaf,
  resolveDropZone,
  resolveEdgeDropZone,
  type ChatPaneLeaf,
  type ChatPaneNode,
} from "~/chatPanes.logic";
import { isChatPaneDragActive, startChatPaneDrag, useChatPaneDragStore } from "~/chatPaneDragStore";
import { commitChatPaneDrop, openCreatedSurfaceInSplit, useChatPanesStore } from "~/chatPanesStore";
import ChatView, { type ChatPaneHeaderProps } from "~/components/ChatView";
import { AddSurfaceMenu, surfaceTitle } from "~/components/RightPanelTabs";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useProject, useThreadDetail, useThreadShell, useThreadStatus } from "~/state/entities";
import { useEnvironment } from "~/state/environments";
import { buildThreadRouteParams } from "~/threadRoutes";
import { resolveThreadSyncPhase } from "~/threadSync";
import { ChatPaneDropOverlay } from "./ChatPaneDropOverlay";
import { ChatPaneResizeHandle } from "./ChatPaneResizeHandle";

/**
 * Renders the split layout. Every leaf mounts its own ChatView; the route
 * thread is the focused pane and owns the shortcuts and autofocus that must
 * only fire once per window. Clicking into another pane navigates to its
 * thread, which moves the focus ring without touching the layout.
 */
export function ChatPanes({
  root,
  routeThreadRef,
}: {
  root: ChatPaneNode;
  routeThreadRef: ScopedThreadRef;
}) {
  const navigate = useNavigate();
  const focusPane = useChatPanesStore((state) => state.focusPane);
  const routeThreadKey = scopedThreadKey(routeThreadRef);
  const routeLeaf = useMemo(() => findLeaf(root, routeThreadRef), [root, routeThreadRef]);

  useEffect(() => {
    if (!routeLeaf) return;
    // A surface pane the route thread just opened keeps focus; pointing back
    // at its chat leaf would dim the pane the split was made for.
    const focusedId = useChatPanesStore.getState().focusedPaneId;
    const focused = collectLeaves(root).find((leaf) => leaf.id === focusedId);
    if (focused && scopedThreadKey(focused.threadRef) === routeThreadKey) return;
    focusPane(routeLeaf.id);
  }, [focusPane, root, routeLeaf, routeThreadKey]);

  const follow = useCallback(
    (threadRef: ScopedThreadRef | null) => {
      if (!threadRef) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        replace: true,
      });
    },
    [navigate],
  );

  const activate = useCallback(
    (leaf: ChatPaneLeaf) => {
      focusPane(leaf.id);
      if (scopedThreadKey(leaf.threadRef) === routeThreadKey) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(leaf.threadRef),
      });
    },
    [focusPane, navigate, routeThreadKey],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background" data-chat-panes>
      <ChatPaneDropOverlay paneId={root.id} resolveZone={resolveEdgeDropZone} priority>
        <PaneNode node={root} onActivate={activate} onClosed={follow} />
      </ChatPaneDropOverlay>
    </div>
  );
}

interface PaneNodeProps {
  node: ChatPaneNode;
  onActivate: (leaf: ChatPaneLeaf) => void;
  /** Receives the survivor's thread when the focused pane closed. */
  onClosed: (threadRef: ScopedThreadRef | null) => void;
}

function PaneNode({ node, onActivate, onClosed }: PaneNodeProps) {
  const setRatio = useChatPanesStore((state) => state.setRatio);
  const containerRef = useRef<HTMLDivElement | null>(null);
  if (node.kind === "leaf") {
    return <PaneLeaf leaf={node} onActivate={onActivate} onClosed={onClosed} />;
  }
  const horizontal = node.direction === "horizontal";
  const splitId = node.id;
  return (
    <div
      ref={containerRef}
      className={cn("flex min-h-0 min-w-0 flex-1", horizontal ? "flex-row" : "flex-col")}
      style={{ "--pane-ratio": node.ratio } as CSSProperties}
      data-chat-pane-split={node.direction}
    >
      <div className="flex min-h-0 min-w-0 flex-col" style={{ flex: "var(--pane-ratio) 1 0px" }}>
        <PaneNode node={node.first} onActivate={onActivate} onClosed={onClosed} />
      </div>
      <ChatPaneResizeHandle
        direction={node.direction}
        containerRef={containerRef}
        onRatioChange={(ratio) =>
          containerRef.current?.style.setProperty("--pane-ratio", String(ratio))
        }
        onRatioCommit={(ratio) => setRatio(splitId, ratio)}
      />
      <div
        className="flex min-h-0 min-w-0 flex-col"
        style={{ flex: "calc(1 - var(--pane-ratio)) 1 0px" }}
      >
        <PaneNode node={node.second} onActivate={onActivate} onClosed={onClosed} />
      </div>
    </div>
  );
}

const PaneLeaf = memo(function PaneLeaf({
  leaf,
  onActivate,
  onClosed,
}: {
  leaf: ChatPaneLeaf;
  onActivate: (leaf: ChatPaneLeaf) => void;
  onClosed: (threadRef: ScopedThreadRef | null) => void;
}) {
  const { threadRef } = leaf;
  const focused = useChatPanesStore((state) => state.focusedPaneId === leaf.id);
  const close = useCallback(
    () => onClosed(useChatPanesStore.getState().closePane(leaf.id)),
    [leaf.id, onClosed],
  );
  const shell = useThreadShell(threadRef);
  const detail = useThreadDetail(threadRef);
  const status = useThreadStatus(threadRef);
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: detail !== null,
    shellExists: shell !== null,
    status,
  });

  // A thread deleted elsewhere takes its pane with it.
  useEffect(() => {
    if (status === "deleted") close();
  }, [close, status]);

  const threadTitle = shell?.title ?? "Thread";
  const title = leaf.surface ? `${surfaceTitle(leaf.surface)} · ${threadTitle}` : threadTitle;
  const project = useProject(
    shell ? scopeProjectRef(threadRef.environmentId, shell.projectId) : null,
  );
  const environment = useEnvironment(threadRef.environmentId);
  const origin = [project?.title, environment?.label].filter(Boolean).join(" · ");
  // Picks the pane header up after a short move; a plain click leaves it alone.
  const cancelHeaderDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelHeaderDrag.current?.(), [leaf.id]);
  const headerDrag = (event: ReactPointerEvent<HTMLElement>) => {
    cancelHeaderDrag.current = startChatPaneDrag(event, {
      content: { threadRef, ...(leaf.surface ? { surface: leaf.surface } : {}) },
      title,
      sourcePaneId: leaf.id,
    });
  };
  // The view inside publishes its add-surface actions, which the header's
  // "+" opens as panes beside this one, and the close that also ends a
  // surface pane's sessions. Until it mounts, the close is the bare pane.
  const [header, setHeader] = useState<ChatPaneHeaderProps | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  return (
    <ChatPaneDropOverlay paneId={leaf.id} resolveZone={resolveDropZone}>
      <section
        aria-label={title}
        data-chat-pane={leaf.id}
        data-chat-pane-focused={focused ? "true" : "false"}
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col",
          !focused &&
            "after:pointer-events-none after:absolute after:inset-0 after:z-30 after:bg-background/35 after:transition-opacity after:duration-150",
        )}
        onPointerDownCapture={(event) => {
          // The header starts a move, not a switch: activating here would
          // remount the pane under the pointer and drop the gesture.
          if (event.target instanceof Element && event.target.closest("[data-chat-pane-header]")) {
            return;
          }
          if (!focused && !isChatPaneDragActive()) onActivate(leaf);
        }}
      >
        <div
          className={cn(
            "flex h-8 shrink-0 items-center gap-1.5 border-b border-border/70 px-2 text-xs",
            focused ? "text-foreground" : "text-muted-foreground",
          )}
          data-chat-pane-header
          onPointerDown={headerDrag}
        >
          <GripVerticalIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/60" />
          <span className="flex min-w-0 flex-1 cursor-grab items-baseline gap-1.5 select-none active:cursor-grabbing">
            <span className="min-w-0 shrink-0 truncate font-medium">{title}</span>
            {origin ? (
              <span className="min-w-0 truncate text-muted-foreground/70">{origin}</span>
            ) : null}
          </span>
          {header ? (
            <AddSurfaceMenu
              {...header.addSurface}
              // Land beside this pane, whichever pane had focus before the menu opened.
              onAdd={(create) => {
                useChatPanesStore.getState().focusPane(leaf.id);
                openCreatedSurfaceInSplit(threadRef, create);
              }}
              open={addMenuOpen}
              onOpenChange={setAddMenuOpen}
              align="end"
              trigger={
                <Button
                  variant="ghost"
                  size="icon-micro"
                  aria-label="Add pane"
                  onPointerDown={(event) => event.stopPropagation()}
                />
              }
            />
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-micro"
                  aria-label={`Close pane for ${title}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={header?.close ?? close}
                />
              }
            >
              <XIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Close pane</TooltipPopup>
          </Tooltip>
        </div>
        {shell ? (
          <ChatView
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            routeKind="server"
            threadSyncPhase={threadSyncPhase}
            paneMode={focused ? "focused" : "background"}
            {...(leaf.surface ? { paneSurface: leaf.surface } : {})}
            onPaneHeaderProps={setHeader}
            reserveTitleBarControlInset={false}
          />
        ) : null}
      </section>
    </ChatPaneDropOverlay>
  );
});

/**
 * Present only while content is carried. A full-window shield keeps the
 * release out of embedded browsers and other pane content, so it always
 * lands here and applies the target the pane overlays resolved; the label
 * follows the pointer above it.
 */
export function ChatPaneDragLayer({ routeThreadRef }: { routeThreadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const title = useChatPaneDragStore((state) => (state.content ? state.title : null));
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (title === null) return;
    const node = ref.current;
    if (!node) return;
    const onMove = (event: PointerEvent) => {
      const x = Math.min(event.clientX + 14, window.innerWidth - node.offsetWidth - 8);
      const y = Math.min(event.clientY + 10, window.innerHeight - node.offsetHeight - 8);
      node.style.transform = `translate(${x}px, ${y}px)`;
    };
    document.addEventListener("pointermove", onMove, { capture: true, passive: true });
    return () => document.removeEventListener("pointermove", onMove, { capture: true });
  }, [title]);
  if (title === null) return null;
  return (
    <div
      className="fixed inset-0 z-[60] touch-none"
      onPointerUp={() => {
        const opened = commitChatPaneDrop(routeThreadRef);
        if (opened) {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(opened),
            replace: true,
          });
        }
      }}
    >
      <div
        ref={ref}
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 max-w-64 truncate rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs font-medium text-popover-foreground shadow-lg will-change-transform"
        style={{ transform: "translate(-9999px, -9999px)" }}
      >
        {title}
      </div>
    </div>
  );
}
