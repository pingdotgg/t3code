import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, useEffect, useEffectEvent, useRef } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { paneRowCounts, resolvePaneSizes, type Pane } from "../../paneLayout";
import { usePaneLayoutStore } from "../../paneLayoutStore";
import { buildThreadRouteParams, type ThreadRouteTarget } from "../../threadRoutes";
import { THREAD_CONTEXT_DROP_EVENT, threadContextDropTargetProps } from "../chat/threadContextDrag";
import { ThreadRouteView } from "../ThreadRouteView";
import { SidebarInset } from "../ui/sidebar";
import { PaneDivider } from "./PaneDivider";
import type { PaneContextValue } from "./PaneContext";

/**
 * The split view: up to six conversations tiled in the main area. The focused pane shows what the
 * route shows (so a new draft still opens in place); the others show their own thread.
 */
export function PaneGrid({
  routeTarget,
  background,
}: {
  routeTarget: ThreadRouteTarget;
  background: boolean;
}) {
  const panes = usePaneLayoutStore((state) => state.panes);
  const storedFocusedIndex = usePaneLayoutStore((state) => state.focusedIndex);
  // The route is ahead of the store for one render after a navigation, so read focus from it.
  const routeKey = routeTarget.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;
  const routeIndex =
    routeKey === null ? -1 : panes.findIndex((pane) => scopedThreadKey(pane.ref) === routeKey);
  const focusedIndex = routeIndex === -1 ? storedFocusedIndex : routeIndex;
  const savedSizes = usePaneLayoutStore((state) => state.sizes);
  const sizes = resolvePaneSizes(savedSizes, panes.length);
  const rowCounts = paneRowCounts(panes.length);
  const rowStarts = rowCounts.map((_, row) => rowCounts.slice(0, row).reduce((a, b) => a + b, 0));
  const layout = usePaneLayoutStore.getState;
  return (
    <SidebarInset
      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
      inert={background}
    >
      <div className="flex min-h-0 flex-1 flex-col p-1.5" data-testid="pane-grid">
        {rowCounts.map((count, row) => (
          <Fragment key={`row-${panes[rowStarts[row]!]!.id}`}>
            {row > 0 ? (
              <PaneDivider
                axis="row"
                onCommit={(delta, min) => layout().resizeRows(panes.length, row - 1, delta, min)}
                onReset={() => layout().resetSizes()}
              />
            ) : null}
            <div className="flex min-h-0 min-w-0" style={{ flex: `${sizes.rows[row]} 1 0%` }}>
              {panes.slice(rowStarts[row], rowStarts[row]! + count).map((pane, column) => {
                const index = rowStarts[row]! + column;
                const focused = index === focusedIndex;
                return (
                  <Fragment key={pane.id}>
                    {column > 0 ? (
                      <PaneDivider
                        axis="column"
                        onCommit={(delta, min) =>
                          layout().resizeCols(panes.length, row, column - 1, delta, min)
                        }
                        onReset={() => layout().resetSizes()}
                      />
                    ) : null}
                    <PaneCellView
                      pane={pane}
                      index={index}
                      weight={sizes.cols[row]![column]!}
                      focused={focused}
                      target={focused ? routeTarget : { kind: "server", threadRef: pane.ref }}
                      topLeading={index === 0}
                      topTrailing={row === 0 && column === count - 1}
                    />
                  </Fragment>
                );
              })}
            </div>
          </Fragment>
        ))}
      </div>
    </SidebarInset>
  );
}

function PaneCellView({
  pane,
  index,
  weight,
  focused,
  target,
  topLeading,
  topTrailing,
}: {
  pane: Pane;
  index: number;
  weight: number;
  focused: boolean;
  target: ThreadRouteTarget;
  topLeading: boolean;
  topTrailing: boolean;
}) {
  const navigate = useNavigate();
  const cellRef = useRef<HTMLDivElement>(null);

  const focusPane = () => {
    if (focused) return;
    // The route is the source of truth; the layout store follows it.
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(pane.ref),
    });
  };
  // A focused cell renders the route, which can still name a removed thread; drop that thread,
  // never this cell's own, then move the route to the pane that took focus.
  const onMissing = useStableCallback(() => {
    if (target.kind !== "server") return;
    usePaneLayoutStore.getState().removeThread(target.threadRef);
    if (!focused) return;
    const { panes, focusedIndex } = usePaneLayoutStore.getState();
    const next = panes[focusedIndex]?.ref;
    if (next) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(next),
        replace: true,
      });
    }
  });
  const handleDrop = useEffectEvent((refs: ReadonlyArray<ScopedThreadRef>) => {
    const ref = refs[0];
    if (ref === undefined) return;
    usePaneLayoutStore.getState().replacePane(index, ref);
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the pane to the sidebar's thread-drop event
  useEffect(() => {
    const element = cellRef.current;
    if (!element) return;
    const listener = (event: Event) =>
      handleDrop((event as CustomEvent<ReadonlyArray<ScopedThreadRef>>).detail);
    element.addEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    return () => element.removeEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
  }, []);

  const onClose = useStableCallback(() => {
    usePaneLayoutStore.getState().closePane(index);
    if (!focused) return;
    // The route still names the closed thread; move it to the pane that took focus.
    const { panes, focusedIndex } = usePaneLayoutStore.getState();
    const next = panes[focusedIndex]?.ref;
    if (next)
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(next) });
  });
  const context: PaneContextValue = { focused, topLeading, topTrailing, index, onClose };
  return (
    <div
      ref={cellRef}
      {...threadContextDropTargetProps()}
      className="group/pane relative flex min-h-0 min-w-0 overflow-hidden rounded-lg border bg-background transition-shadow data-[focused=true]:ring-1 data-[focused=true]:ring-primary/50 data-pane-dragging:opacity-60 data-pane-drop-target:ring-2 data-pane-drop-target:ring-primary data-thread-context-over:ring-2 data-thread-context-over:ring-primary"
      data-focused={focused}
      data-pane-id={pane.id}
      data-pane-index={index}
      data-pane-thread={scopedThreadKey(pane.ref)}
      data-testid="pane"
      style={{ flex: `${weight} 1 0%` }}
      onPointerDownCapture={focusPane}
    >
      <ThreadRouteView target={target} pane={{ context, onMissing }} />
    </div>
  );
}
