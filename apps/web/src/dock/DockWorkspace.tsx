import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  Fragment,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { DOCK_LAYOUT_EVENT } from "./dockEvents";
import { DockHostPortal } from "./DockHostPortal";
import {
  CHAT_GROUP_ID,
  DEFAULT_DOCK_NODE_SIZE,
  dockElasticChild,
  dockNodeContainsGroup,
  DOCK_GROUP_MIN_SIZE,
  isDockNodeVisible,
  type DockDirection,
  type DockNode,
  type DockSplitNode,
} from "./dockLayout";
import { useDockLayoutStore } from "./dockLayoutStore";
import { setDockSlot, useDockGroupSlots, useDockSlotStore } from "./dockSlots";
import type { DockGroupView, DockView } from "./dockView";
import { useDockView } from "./useDockView";

const CHAT_MIN_SIZE = 320;
const TITLEBAR_CONTROLS_INSET = "3.5rem";
const SASH_KEY_STEP = 16;

interface DockContext {
  readonly view: DockView;
  readonly threadRef: ScopedThreadRef | null;
}

function DockGroupFrame(props: { readonly context: DockContext; readonly group: DockGroupView }) {
  const { context, group } = props;
  const { edges, maximizedGroupId } = context.view;
  const { id } = group;
  // Created once: slots must keep their identity, or a re-render would re-register them.
  const [attachBody] = useState(() => (element: HTMLDivElement) => {
    setDockSlot(id, "body", element);
    return () => setDockSlot(id, "body", null);
  });
  const [attachTabs] = useState(() => (element: HTMLDivElement) => {
    setDockSlot(id, "tabs", element);
    return () => setDockSlot(id, "tabs", null);
  });
  const hasTabBar = group.launcher || group.surfaces.length > 0;
  const maximized = maximizedGroupId === id;
  const covered = maximizedGroupId !== null && !maximized;
  return (
    <section
      data-dock-group={id}
      data-dock-titlebar-left={edges.left === id}
      inert={covered}
      className={cn(
        "flex size-full min-h-0 min-w-0 flex-col bg-background",
        maximized ? "absolute inset-0 z-20" : "relative",
        // Contains layers like the composer's, which would otherwise rise over the maximized group.
        covered && "isolate",
      )}
      style={
        {
          "--dock-titlebar-end-inset": edges.right === id ? TITLEBAR_CONTROLS_INSET : "0.75rem",
        } as CSSProperties
      }
      onPointerDownCapture={() => {
        const surface = group.activeSurface;
        const { threadRef } = context;
        if (!surface || !threadRef) return;
        const panels = useRightPanelStore.getState();
        if (
          selectThreadRightPanelState(panels.byThreadKey, threadRef).activeSurfaceId !== surface.id
        )
          panels.activateSurface(threadRef, surface.id);
      }}
    >
      {hasTabBar ? (
        <div
          ref={attachTabs}
          data-dock-tabbar=""
          className={cn(
            "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pl-2 pr-(--dock-titlebar-end-inset)",
            isElectron && edges.top.has(id) && "drag-region",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        />
      ) : null}
      <div ref={attachBody} data-dock-body="" className="relative min-h-0 min-w-0 flex-1" />
    </section>
  );
}

function attachDockRoot(root: HTMLDivElement) {
  useDockSlotStore.setState({ root });
  return () => useDockSlotStore.setState({ root: null });
}

function fixedDockSize(node: DockNode) {
  return node.size ?? DEFAULT_DOCK_NODE_SIZE;
}

function DockSash(props: {
  readonly direction: DockDirection;
  readonly before: DockNode;
  readonly after: DockNode;
  readonly elastic: DockNode | undefined;
}) {
  const { direction, before, after, elastic } = props;
  const row = direction === "row";
  const resizeFrom = (sash: HTMLElement) => {
    const beforeFrame = sash.previousElementSibling as HTMLElement;
    const afterFrame = sash.nextElementSibling as HTMLElement;
    const extent = (frame: HTMLElement) => {
      const rect = frame.getBoundingClientRect();
      return row ? rect.width : rect.height;
    };
    const beforeStart = extent(beforeFrame);
    const afterStart = extent(afterFrame);
    const total = beforeStart + afterStart;
    let sizes: Record<string, number> = {};
    const apply = (delta: number) => {
      const beforeSize = Math.round(
        Math.max(DOCK_GROUP_MIN_SIZE, Math.min(total - DOCK_GROUP_MIN_SIZE, beforeStart + delta)),
      );
      const afterSize = total - beforeSize;
      sizes = {};
      // The elastic neighbour follows on its own, and keeps ignoring its stored size.
      if (before !== elastic) {
        sizes[before.id] = beforeSize;
        beforeFrame.style.flexBasis = `${beforeSize}px`;
      }
      if (after !== elastic) {
        sizes[after.id] = afterSize;
        afterFrame.style.flexBasis = `${afterSize}px`;
      }
      window.dispatchEvent(new Event(DOCK_LAYOUT_EVENT));
    };
    return { apply, commit: () => useDockLayoutStore.getState().setNodeSizes(sizes) };
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const sash = event.currentTarget;
    const start = row ? event.clientX : event.clientY;
    const session = resizeFrom(sash);
    const { pointerId } = event;
    sash.setPointerCapture(pointerId);
    document.documentElement.dataset.dockDragging = "true";
    const move = (next: PointerEvent) => {
      session.apply((row ? next.clientX : next.clientY) - start);
    };
    const end = () => {
      sash.removeEventListener("pointermove", move);
      sash.removeEventListener("pointerup", end);
      sash.removeEventListener("pointercancel", end);
      delete document.documentElement.dataset.dockDragging;
      session.commit();
    };
    sash.addEventListener("pointermove", move);
    sash.addEventListener("pointerup", end);
    sash.addEventListener("pointercancel", end);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === (row ? "ArrowLeft" : "ArrowUp")
        ? -SASH_KEY_STEP
        : event.key === (row ? "ArrowRight" : "ArrowDown")
          ? SASH_KEY_STEP
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const session = resizeFrom(event.currentTarget);
    session.apply(step);
    session.commit();
  };
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label="Resize panels"
      aria-orientation={row ? "vertical" : "horizontal"}
      data-dock-sash=""
      className={cn(
        "group/sash relative z-10 shrink-0 touch-none bg-border outline-none",
        row ? "-mx-px w-px cursor-col-resize" : "-my-px h-px cursor-row-resize",
      )}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden
        className={cn(
          "absolute transition-colors duration-150 group-hover/sash:bg-primary/40 group-focus-visible/sash:bg-primary/60 group-active/sash:bg-primary/60",
          row ? "inset-y-0 -left-1 w-2" : "inset-x-0 -top-1 h-2",
        )}
      />
    </div>
  );
}

function DockSplitView(props: { readonly context: DockContext; readonly node: DockSplitNode }) {
  const { context, node } = props;
  const groupIds = context.view.groups;
  const visible = node.children.filter((child) =>
    isDockNodeVisible(child, new Set(groupIds.keys())),
  );
  const elastic = dockElasticChild(visible);
  const row = node.direction === "row";
  return (
    <div
      {...(visible.length > 1 && node !== context.view.root
        ? { "data-dock-stack": node.id, "data-dock-direction": node.direction }
        : {})}
      className={cn("flex size-full min-h-0 min-w-0", row ? "flex-row" : "flex-col")}
    >
      {visible.map((child, index) => {
        const minSize = dockNodeContainsGroup(child, CHAT_GROUP_ID)
          ? CHAT_MIN_SIZE
          : DOCK_GROUP_MIN_SIZE;
        const previous = visible[index - 1];
        return (
          <Fragment key={child.id}>
            {previous ? (
              <DockSash
                direction={node.direction}
                before={previous}
                after={child}
                elastic={elastic}
              />
            ) : null}
            <div
              data-dock-frame={child.id}
              className="min-h-0 min-w-0 overflow-hidden"
              style={{
                flex: child === elastic ? "1 1 0" : `0 1 ${fixedDockSize(child)}px`,
                [row ? "minWidth" : "minHeight"]: minSize,
              }}
            >
              <DockNodeView context={context} node={child} />
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

function DockNodeView(props: { readonly context: DockContext; readonly node: DockNode }) {
  const { context, node } = props;
  if (node.kind === "split") return <DockSplitView context={context} node={node} />;
  const group = context.view.groups.get(node.id);
  return group ? <DockGroupFrame key={node.id} context={context} group={group} /> : null;
}

/**
 * The chat and the thread's panels as a tree of splits and tab groups. The routed page lives in
 * the chat's group; ChatView portals the thread's surfaces into the rest, because it owns their
 * props. The threads sidebar stays outside the tree, pinned to its window edge.
 */
export function DockWorkspace(props: {
  readonly className?: string | undefined;
  readonly children: ReactNode;
}) {
  const threadRef = useDockLayoutStore((state) => state.threadRef);
  const view = useDockView(threadRef);
  const chatSlot = useDockGroupSlots(CHAT_GROUP_ID).body;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- browser surfaces track their on-screen rect, which a dock change can move without resizing
  useLayoutEffect(() => {
    window.dispatchEvent(new Event(DOCK_LAYOUT_EVENT));
  });
  return (
    <div
      ref={attachDockRoot}
      data-dock-root=""
      className={cn(
        "relative flex h-dvh min-h-0 min-w-0 flex-1 overflow-hidden [&_[data-slot=sidebar-inset]]:h-full!",
        props.className,
      )}
    >
      <DockNodeView context={{ view, threadRef }} node={view.root} />
      <DockHostPortal slot={chatSlot}>{props.children}</DockHostPortal>
    </div>
  );
}
