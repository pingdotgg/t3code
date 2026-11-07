import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef } from "react";

import { MAX_PANES, isSplitLayout } from "../../paneLayout";
import { usePaneLayoutStore } from "../../paneLayoutStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  THREAD_CONTEXT_DROP_EVENT,
  threadContextDropTargetProps,
  useThreadContextDragGhost,
} from "../chat/threadContextDrag";
import { openThreadInPane } from "./paneActions";

/**
 * A strip down the right edge, shown only while a sidebar thread is being dragged. Dropping on it
 * opens that thread as another pane; dropping on a pane replaces that pane instead.
 */
export function PaneAddDropZone({ current }: { current: ScopedThreadRef | null }) {
  const dragging = useThreadContextDragGhost() !== null;
  const paneCount = usePaneLayoutStore((state) => state.panes.length);
  const split = usePaneLayoutStore(isSplitLayout);
  const canAdd = split ? paneCount < MAX_PANES : current !== null;
  if (!dragging || !canAdd) return null;
  return <PaneAddStrip current={current} />;
}

function PaneAddStrip({ current }: { current: ScopedThreadRef | null }) {
  const navigate = useNavigate();
  const stripRef = useRef<HTMLDivElement>(null);
  const handleDrop = useEffectEvent((refs: ReadonlyArray<ScopedThreadRef>) => {
    let base = current;
    for (const ref of refs) {
      openThreadInPane(base, ref, (next) =>
        navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(next) }),
      );
      base = null;
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the strip to the sidebar's thread-drop event
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const listener = (event: Event) =>
      handleDrop((event as CustomEvent<ReadonlyArray<ScopedThreadRef>>).detail);
    strip.addEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    return () => strip.removeEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
  }, []);
  return (
    <div
      ref={stripRef}
      {...threadContextDropTargetProps()}
      className="fixed inset-y-0 right-0 z-40 flex w-24 items-center justify-center border-l-2 border-dashed border-primary/40 bg-primary/5 text-primary/70 transition-colors data-thread-context-over:border-primary data-thread-context-over:bg-primary/15 data-thread-context-over:text-primary"
      data-testid="pane-add-drop-zone"
    >
      <div className="pointer-events-none flex flex-col items-center gap-1 text-xs font-medium">
        <PlusIcon className="size-5" />
        New pane
      </div>
    </div>
  );
}
