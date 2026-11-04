import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  deriveSideChatTree,
  type SideChatTreeRow,
} from "@t3tools/client-runtime/state/thread-relationships";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BookOpenIcon, MessageCircleIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { observeResize } from "../../lib/observeResize";
import { layoutSideChatTree } from "../../lib/sideChatTreeLayout";
import { cn } from "../../lib/utils";
import {
  selectLastSideChatSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import { useQuietThreadShell, useSideChatTreeShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ThreadRelationshipIcon } from "../chat/ThreadRelationshipIcon";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  fitSideChatMapScale,
  resolveSideChatMapKeyTarget,
  SIDE_CHAT_MAP_LAYOUT,
  sideChatMapNodeDescription,
  sideChatMapNodeStatus,
} from "./SideChatMap.logic";
import { focusSideChat } from "./sideChatNavigation";

// The scroller's p-3, left and right.
const SCROLLER_PADDING_X = 24;
const ARROW_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

function nodeSelector(threadId: ThreadId): string {
  return `[data-thread-id="${CSS.escape(threadId)}"]`;
}

/**
 * The side-chat tree as a diagram: edges drawn in SVG, nodes as buttons placed
 * over them so focus, tooltips and truncation work like any other control.
 */
export function SideChatMap(props: {
  readonly rows: ReadonlyArray<SideChatTreeRow>;
  readonly currentThreadId: ThreadId;
  readonly onOpenSideChat: (threadId: ThreadId) => void;
  readonly onFocusLesson: () => void;
}) {
  const { rows, currentThreadId } = props;
  const [fit, setFit] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [focusedId, setFocusedId] = useState<ThreadId | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const layout = layoutSideChatTree(rows, SIDE_CHAT_MAP_LAYOUT);
  const scale = fit ? fitSideChatMapScale(layout.width, availableWidth) : 1;
  const tabStopId = rows.some((row) => row.threadId === focusedId) ? focusedId : currentThreadId;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a resize observer on the scroller whose width sets the fitted map's scale
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!fit || scroller === null) return;
    return observeResize(scroller, () =>
      setAvailableWidth(scroller.clientWidth - SCROLLER_PADDING_X),
    );
  }, [fit]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the current side chat's node into view in the map's DOM when it changes
  useEffect(() => {
    treeRef.current
      ?.querySelector(nodeSelector(currentThreadId))
      ?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [currentThreadId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-end px-2 pt-2">
        <Toggle
          size="xs"
          variant="ghost"
          pressed={fit}
          onPressedChange={setFit}
          aria-label="Fit map to panel"
        >
          Fit
        </Toggle>
      </div>
      {/* Fit scales by the scroller's width, so a vertical scrollbar must not change it, or a tall map rescales every frame. */}
      <div ref={scrollerRef} className="scrollbar-gutter-stable min-h-0 flex-1 overflow-auto p-3">
        <div
          className="relative"
          style={{ width: layout.width * scale, height: layout.height * scale }}
        >
          <div
            ref={treeRef}
            role="tree"
            aria-label="Side chat map"
            className="relative origin-top-left"
            style={{
              width: layout.width,
              height: layout.height,
              transform: scale < 1 ? `scale(${scale})` : undefined,
            }}
            onKeyDown={(event) => {
              if (!ARROW_KEYS.has(event.key) || event.altKey || event.ctrlKey || event.metaKey) {
                return;
              }
              if (focusedId === null) return;
              event.preventDefault();
              const target = resolveSideChatMapKeyTarget(rows, focusedId, event.key);
              if (target === null) return;
              event.currentTarget.querySelector<HTMLElement>(nodeSelector(target))?.focus();
            }}
          >
            <svg
              aria-hidden
              className="pointer-events-none absolute inset-0"
              width={layout.width}
              height={layout.height}
            >
              {layout.edges.map((edge) => (
                <path
                  key={`${edge.from}:${edge.to}`}
                  d={edge.path}
                  fill="none"
                  className="stroke-muted-foreground/40"
                  strokeWidth={1.25}
                />
              ))}
            </svg>
            {rows.map((row, index) => {
              const box = layout.nodes[index];
              if (box === undefined) return null;
              const current = row.threadId === currentThreadId;
              const lesson = row.state === "lesson";
              return (
                <Tooltip key={row.threadId}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        role="treeitem"
                        data-thread-id={row.threadId}
                        aria-level={row.depth + 1}
                        aria-selected={current}
                        aria-description={sideChatMapNodeDescription(row)}
                        tabIndex={row.threadId === tabStopId ? 0 : -1}
                        data-workspace-focus-default={row.threadId === tabStopId ? "" : undefined}
                        className={cn(
                          "absolute flex cursor-pointer items-center gap-1.5 rounded-md border bg-card px-1.5 text-left text-foreground text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                          current && "border-primary ring-1 ring-primary",
                          lesson && "font-semibold",
                        )}
                        style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
                        onFocus={() => setFocusedId(row.threadId)}
                        onClick={() =>
                          lesson ? props.onFocusLesson() : props.onOpenSideChat(row.threadId)
                        }
                      />
                    }
                  >
                    <ThreadRelationshipIcon
                      status={sideChatMapNodeStatus(row)}
                      fallbackIcon={lesson ? BookOpenIcon : MessageCircleIcon}
                    />
                    <span className="min-w-0 flex-1 truncate">{row.label}</span>
                  </TooltipTrigger>
                  <TooltipPopup side="top">{row.label}</TooltipPopup>
                </Tooltip>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The Map tab: the lesson's side-chat tree, whichever of the lesson's threads it opens on. */
export function SideChatMapSurface(props: {
  readonly threadRef: ScopedThreadRef;
  readonly onFocusLesson: () => void;
}) {
  const { threadRef } = props;
  const navigate = useNavigate();
  const routeShell = useQuietThreadShell(threadRef);
  const lessonRef = scopeThreadRef(
    threadRef.environmentId,
    routeShell?.sideChat?.lessonThreadId ?? threadRef.threadId,
  );
  const rows = deriveSideChatTree(useSideChatTreeShells(lessonRef), lessonRef.threadId);
  // The active tab is the Map itself, so mark the side chat the learner was last on.
  const shownThreadId = useRightPanelStore(
    (state) =>
      selectLastSideChatSurface(selectThreadRightPanelState(state.byThreadKey, lessonRef))
        ?.threadId ?? null,
  );

  if (rows.length <= 1) {
    return (
      <p className="m-auto max-w-64 p-6 text-center text-muted-foreground text-sm">
        No side chats yet. Select text in a reply and choose Ask in side chat.
      </p>
    );
  }

  // A side chat still starting has no row yet, so the lesson stands in for it.
  const currentThreadId =
    rows.find((row) => row.threadId === shownThreadId)?.threadId ?? lessonRef.threadId;
  const focusLesson = () => {
    if (lessonRef.threadId === threadRef.threadId) {
      props.onFocusLesson();
      return;
    }
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(lessonRef) });
  };

  return (
    <SideChatMap
      rows={rows}
      currentThreadId={currentThreadId}
      onOpenSideChat={(threadId) => focusSideChat(lessonRef, threadId)}
      onFocusLesson={focusLesson}
    />
  );
}
