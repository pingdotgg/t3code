import { useNavigate } from "@tanstack/react-router";
import { Columns2, Maximize2, Minimize2, Rows2, X } from "lucide-react";
import { memo, type CSSProperties, useRef, useState, useEffect, useLayoutEffect } from "react";

import "./SplitChatWorkspace.css";

import { ComposerHandleContext, useComposerHandleContext } from "../../composerHandleContext";
import { usePanelAnimationSettings } from "../../panelAnimations";
import { cn } from "../../lib/utils";
import { threadTargetKey, useSplitChatStore } from "../../splitChatStore";
import { buildThreadRouteParams, type ThreadRouteTarget } from "../../threadRoutes";
import { ThreadRouteView } from "../ThreadRouteView";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SplitChatPaneActiveContext, SplitChatPaneControlsContext } from "./splitChatPaneContext";
import { SplitResizeDivider } from "./SplitResizeDivider";
import { SplitChatDragHandle } from "./SplitChatDragHandle";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  registerThreadWorkspaceDrop,
  moveThreadContextDrag,
  endThreadContextDrag,
} from "./threadContextDrag";

interface SplitChatWorkspaceProps {
  readonly primaryTarget: ThreadRouteTarget | null;
  readonly modalOpen: boolean;
}

export const SplitChatWorkspace = memo(function SplitChatWorkspace({
  primaryTarget,
  modalOpen,
}: SplitChatWorkspaceProps) {
  const navigate = useNavigate();
  const composerHandle = useComposerHandleContext();
  const animations = usePanelAnimationSettings();
  const store = useSplitChatStore();
  const {
    secondaryPanes,
    activePaneIndex,
    horizontalRatio,
    verticalRatio,
    topRowRatio,
    bottomRowRatio,
    rightColumnRatio,
    resizeLayout,
  } = store;
  const [maximizedPaneIndex, setMaximizedPaneIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<ThreadRouteTarget | null>(null);
  const focusTargetRef = useRef<string | null>(null);
  const [pendingPrimary, setPendingPrimary] = useState<{
    previousKey: string;
    target: ThreadRouteTarget;
  } | null>(null);
  const [dropZone, setDropZone] = useState<{
    index: number;
    mode: "swap" | "insert" | "blocked";
  } | null>(null);
  const primaryKey = threadTargetKey(primaryTarget);
  const effectivePrimary =
    pendingPrimary && primaryKey === pendingPrimary.previousKey
      ? pendingPrimary.target
      : primaryTarget;
  if (pendingPrimary && primaryKey !== pendingPrimary.previousKey) setPendingPrimary(null);

  const allPanes = effectivePrimary ? [effectivePrimary, ...secondaryPanes] : [...secondaryPanes];
  const panes = allPanes.filter(
    (pane, index) =>
      allPanes.findIndex((candidate) => threadTargetKey(candidate) === threadTargetKey(pane)) ===
      index,
  );
  const count = panes.length;
  if (count < 2 && maximizedPaneIndex !== null) setMaximizedPaneIndex(null);
  const maximized =
    count > 1 && maximizedPaneIndex !== null && maximizedPaneIndex < count
      ? maximizedPaneIndex
      : null;
  const activeIndex = Math.min(activePaneIndex, count - 1);
  if (maximized !== null && maximized !== activeIndex) setMaximizedPaneIndex(null);
  const columns = count === 4 && resizeLayout === "columns";
  const x = "var(--split-x)";
  const y = "var(--split-y)";
  const topX = "var(--split-top-x)";
  const bottomX = "var(--split-bottom-x)";
  const rightY = "var(--split-right-y)";
  const remaining = (value: string) => `calc(100% - ${value})`;
  const layoutBounds = (size: number): CSSProperties[] =>
    size === 1
      ? [{ left: 0, top: 0, width: "100%", height: "100%" }]
      : size === 2
        ? [
            { left: 0, top: 0, width: x, height: "100%" },
            { left: x, top: 0, width: remaining(x), height: "100%" },
          ]
        : size === 4 && resizeLayout === "columns"
          ? [
              { left: 0, top: 0, width: x, height: y },
              { left: x, top: 0, width: remaining(x), height: rightY },
              { left: 0, top: y, width: x, height: remaining(y) },
              { left: x, top: rightY, width: remaining(x), height: remaining(rightY) },
            ]
          : [
              { left: 0, top: 0, width: topX, height: y },
              { left: topX, top: 0, width: remaining(topX), height: y },
              { left: 0, top: y, width: size === 3 ? "100%" : bottomX, height: remaining(y) },
              { left: bottomX, top: y, width: remaining(bottomX), height: remaining(y) },
            ];

  const bounds = layoutBounds(count);

  const navigatePrimary = (target: ThreadRouteTarget) => {
    setPendingPrimary({ previousKey: primaryKey, target });
    if (target.kind === "server") {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(target.threadRef),
        replace: true,
      });
    } else {
      void navigate({ to: "/draft/$draftId", params: { draftId: target.draftId }, replace: true });
    }
  };
  // Reads the live store so several panes closing in one commit don't restore each other.
  const close = (key: string) => {
    const latest = useSplitChatStore.getState();
    const current = effectivePrimary
      ? [effectivePrimary, ...latest.secondaryPanes]
      : [...latest.secondaryPanes];
    const index = current.findIndex((pane) => threadTargetKey(pane) === key);
    if (index < 0) return;
    setMaximizedPaneIndex((value) =>
      value === null || value === index ? null : value > index ? value - 1 : value,
    );
    const next = current.filter((_, paneIndex) => paneIndex !== index);
    const nextPrimary = next[0];
    if (!nextPrimary) return;
    const activeIndex = latest.activePaneIndex;
    const active =
      activeIndex > index
        ? activeIndex - 1
        : activeIndex === index
          ? Math.min(index, next.length - 1)
          : activeIndex;
    if (index === 0) navigatePrimary(nextPrimary);
    if (activeIndex === index) focusTargetRef.current = threadTargetKey(next[active]);
    store.replaceSecondaryPanes(next.slice(1), active);
  };
  const resolveDrop = (
    point: { x: number; y: number },
    target: ThreadRouteTarget | null,
    multiple = false,
  ) => {
    const container = containerRef.current;
    if (!container || modalOpen || maximized !== null) return null;
    const rect = container.getBoundingClientRect();
    if (point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom)
      return null;
    const source = panes.findIndex((pane) => threadTargetKey(pane) === threadTargetKey(target));
    if (multiple || (source < 0 && count >= 4)) return { index: 0, mode: "blocked" as const };
    const paneElements = container.querySelectorAll<HTMLElement>("[data-split-pane-index]");
    let index = Array.from(paneElements).findIndex((pane) => {
      const box = pane.getBoundingClientRect();
      return (
        point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom
      );
    });
    if (index < 0) return null;
    if (source >= 0) return source === index ? null : { index, mode: "swap" as const };
    if (count === 1) index = point.x < rect.left + rect.width / 2 ? 0 : 1;
    if (count === 2 && point.y > rect.top + rect.height * 0.75) index = 2;
    if (count === 3 && index === 2 && point.x > rect.left + rect.width * bottomRowRatio) index = 3;
    return { index, mode: "insert" as const };
  };
  const place = (target: ThreadRouteTarget, zone: NonNullable<typeof dropZone>) => {
    if (zone.mode === "blocked") return false;
    const next = [...panes];
    const source = next.findIndex((pane) => threadTargetKey(pane) === threadTargetKey(target));
    if (source >= 0) {
      const destination = next[zone.index];
      if (!destination) return false;
      next[source] = destination;
      next[zone.index] = target;
    } else {
      if (next.length >= 4) return false;
      next.splice(zone.index, 0, target);
    }
    const nextPrimary = next[0];
    if (!nextPrimary) return false;
    if (threadTargetKey(nextPrimary) !== threadTargetKey(effectivePrimary))
      navigatePrimary(nextPrimary);
    focusTargetRef.current = threadTargetKey(target);
    store.replaceSecondaryPanes(next.slice(1), zone.index);
    setDropZone(null);
    return true;
  };
  const showDrop = useStableCallback(
    (point: { x: number; y: number } | null, targets: readonly ThreadRouteTarget[]) => {
      const next = point
        ? resolveDrop(point, sourceRef.current ?? targets[0] ?? null, targets.length > 1)
        : null;
      setDropZone((previous) =>
        previous?.index === next?.index && previous?.mode === next?.mode ? previous : next,
      );
    },
  );
  const dropThread = useStableCallback(
    (point: { x: number; y: number }, targets: readonly ThreadRouteTarget[]) => {
      const target = sourceRef.current ?? targets[0];
      if (!target) return false;
      const zone = resolveDrop(point, target, targets.length > 1);
      return zone ? place(target, zone) : false;
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the workspace with the sidebar's pointer drag dispatcher
  useEffect(
    () =>
      registerThreadWorkspaceDrop({
        move: (point, threads) =>
          showDrop(
            point,
            threads.map((threadRef) => ({ kind: "server", threadRef })),
          ),
        drop: (point, threads) =>
          dropThread(
            point,
            threads.map((threadRef) => ({ kind: "server", threadRef })),
          ),
      }),
    [showDrop, dropThread],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reconciles split membership when the URL opens an existing secondary thread
  useEffect(() => {
    if (panes.length === allPanes.length) return;
    const activeTarget = allPanes[activePaneIndex];
    const activeIndex = panes.findIndex(
      (pane) => threadTargetKey(pane) === threadTargetKey(activeTarget),
    );
    store.replaceSecondaryPanes(
      effectivePrimary ? panes.slice(1) : panes,
      Math.max(0, activeIndex),
    );
  }, [panes, allPanes, activePaneIndex, effectivePrimary, store]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores DOM focus after a pane is closed or moved
  useLayoutEffect(() => {
    const key = focusTargetRef.current;
    if (!key) return;
    const pane = Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>("[data-split-pane-key]") ?? [],
    ).find((element) => element.dataset.splitPaneKey === key);
    if (!pane) return;
    focusTargetRef.current = null;
    const handle = pane.querySelector<HTMLElement>('[aria-label="Drag chat to rearrange"]');
    (handle ?? pane).focus({ preventScroll: true });
  });

  if (count === 0) return null;
  const divider = (
    property: string,
    orientation: "vertical" | "horizontal",
    ratio: number,
    onResize: (value: number) => void,
    style: CSSProperties,
  ) => (
    <SplitResizeDivider
      key={property}
      containerRef={containerRef}
      property={property}
      orientation={orientation}
      ratio={ratio}
      onResize={onResize}
      style={style}
    />
  );

  return (
    <SidebarInset
      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
      inert={modalOpen}
    >
      <div
        ref={containerRef}
        data-split-workspace
        data-split-layout={columns ? "columns" : "rows"}
        className={cn("relative flex-1 min-h-0 min-w-0 overflow-hidden", count > 1 && "m-1")}
        style={
          {
            "--split-x": `${horizontalRatio * 100}%`,
            "--split-y": `${verticalRatio * 100}%`,
            "--split-top-x": `${topRowRatio * 100}%`,
            "--split-bottom-x": `${bottomRowRatio * 100}%`,
            "--split-right-y": `${rightColumnRatio * 100}%`,
          } as CSSProperties
        }
      >
        {panes.map((target, index) => (
          <div
            // The primary pane keeps one key so draft promotion keeps its ChatView mounted.
            key={index === 0 ? "primary" : threadTargetKey(target)}
            data-split-pane-index={index}
            data-split-pane-key={threadTargetKey(target)}
            tabIndex={-1}
            hidden={maximized !== null && maximized !== index}
            style={{
              ...(maximized === index
                ? { left: 0, top: 0, width: "100%", height: "100%" }
                : bounds[index]),
              animationDuration: animations.active
                ? `${Math.min(animations.durationMs, 160)}ms`
                : "0ms",
            }}
            className={cn("absolute min-h-0 min-w-0", count > 1 && "p-1")}
            onPointerDown={() => store.setActivePane(index)}
            onFocusCapture={() => store.setActivePane(index)}
          >
            <div
              className={cn(
                "relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background",
                count > 1 &&
                  "rounded-lg border transition-colors duration-150 motion-reduce:transition-none",
                count > 1 && (activePaneIndex === index ? "border-primary/40" : "border-border"),
              )}
            >
              <SplitChatPaneControlsContext
                value={
                  count > 1 ? (
                    <div
                      className="relative z-10 flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]"
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      {maximized === null ? (
                        <SplitChatDragHandle
                          target={target}
                          onMove={(point, title) => {
                            sourceRef.current = target;
                            moveThreadContextDrag(point, { title, count: 1, pane: true });
                          }}
                          onDrop={(point) => {
                            sourceRef.current = target;
                            dropThread(point, [target]);
                          }}
                          onEnd={() => {
                            sourceRef.current = null;
                            endThreadContextDrag();
                          }}
                          onMoveByKeyboard={(direction) => {
                            const destination = (index + direction + count) % count;
                            if (destination !== index)
                              place(target, { index: destination, mode: "swap" });
                          }}
                        />
                      ) : null}
                      {count === 4 ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                aria-label={
                                  columns
                                    ? "Resize rows independently"
                                    : "Resize columns independently"
                                }
                                onClick={() => store.setResizeLayout(columns ? "rows" : "columns")}
                              >
                                {columns ? <Rows2 /> : <Columns2 />}
                              </Button>
                            }
                          />
                          <TooltipPopup>
                            {columns ? "Resize rows independently" : "Resize columns independently"}
                          </TooltipPopup>
                        </Tooltip>
                      ) : null}
                      {count > 1 ? (
                        <>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label={
                                    maximized === index
                                      ? "Restore split layout"
                                      : "Maximize chat pane"
                                  }
                                  onClick={() => {
                                    store.setActivePane(index);
                                    setMaximizedPaneIndex(maximized === index ? null : index);
                                  }}
                                >
                                  {maximized === index ? <Minimize2 /> : <Maximize2 />}
                                </Button>
                              }
                            />
                            <TooltipPopup>
                              {maximized === index ? "Restore split layout" : "Maximize this chat"}
                            </TooltipPopup>
                          </Tooltip>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label="Close chat pane"
                            onClick={() => close(threadTargetKey(target))}
                          >
                            <X />
                          </Button>
                        </>
                      ) : null}
                    </div>
                  ) : null
                }
              >
                <SplitChatPaneActiveContext value={index === activeIndex}>
                  {/* The app-wide composer handle belongs to the active pane only. */}
                  <ComposerHandleContext value={index === activeIndex ? composerHandle : null}>
                    <ThreadRouteView
                      target={target}
                      asPane
                      ownsRoute={index === 0}
                      background={modalOpen}
                      onTargetUnavailable={
                        count > 1 ? () => close(threadTargetKey(target)) : undefined
                      }
                    />
                  </ComposerHandleContext>
                </SplitChatPaneActiveContext>
              </SplitChatPaneControlsContext>
            </div>
          </div>
        ))}
        {maximized !== null || count < 2 ? null : count === 2 ? (
          divider("--split-x", "vertical", horizontalRatio, store.setHorizontalRatio, {
            left: x,
            top: 0,
            height: "100%",
          })
        ) : columns ? (
          <>
            {divider("--split-x", "vertical", horizontalRatio, store.setHorizontalRatio, {
              left: x,
              top: 0,
              height: "100%",
            })}
            {divider("--split-y", "horizontal", verticalRatio, store.setVerticalRatio, {
              left: 0,
              top: y,
              width: x,
            })}
            {divider("--split-right-y", "horizontal", rightColumnRatio, store.setRightColumnRatio, {
              left: x,
              top: rightY,
              width: remaining(x),
            })}
          </>
        ) : (
          <>
            {divider("--split-y", "horizontal", verticalRatio, store.setVerticalRatio, {
              left: 0,
              top: y,
              width: "100%",
            })}
            {divider("--split-top-x", "vertical", topRowRatio, store.setTopRowRatio, {
              left: topX,
              top: 0,
              height: y,
            })}
            {count === 4
              ? divider("--split-bottom-x", "vertical", bottomRowRatio, store.setBottomRowRatio, {
                  left: bottomX,
                  top: y,
                  height: remaining(y),
                })
              : null}
          </>
        )}
        {dropZone ? (
          <div
            key={`${dropZone.mode}:${dropZone.index}`}
            aria-hidden="true"
            data-split-drop-preview
            className="pointer-events-none absolute z-40 flex items-center justify-center rounded-lg border-2 border-primary/50 bg-primary/10 p-4"
            style={{
              ...(dropZone.mode === "blocked"
                ? { inset: 4 }
                : (dropZone.mode === "swap" ? bounds : layoutBounds(count + 1))[dropZone.index]),
              animationDuration: animations.active
                ? `${Math.min(animations.durationMs, 120)}ms`
                : "0ms",
            }}
          >
            <span className="rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-sm">
              {dropZone.mode === "blocked"
                ? "Open up to 4 chats. Drag one chat at a time."
                : dropZone.mode === "swap"
                  ? "Swap chats"
                  : "Open chat here"}
            </span>
          </div>
        ) : null}
      </div>
    </SidebarInset>
  );
});
