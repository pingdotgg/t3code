import {
  type Announcements,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  type DragStartEvent,
  type Over,
} from "@dnd-kit/core";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { createContext, type ReactNode, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import {
  type ContentDropData,
  type DropGhost,
  type DropOver,
  type DropPlan,
  panelCollision,
  resolveDrop,
  samePlan,
} from "./dropTarget.logic";
import { paneLayout, paneOf, type SplitChange } from "./splitLayout.logic";
import { type TabDragData, useTabDragSensors } from "./tabStrip";

/** Only tab strips scroll while a tab is dragged; a diff or file view under the pointer stays put. */
const AUTO_SCROLL = {
  canScroll: (element: Element) =>
    element.matches('[data-slot="scroll-area-viewport"]') &&
    element.closest("[data-right-panel-tab-list]") !== null,
};

function titleOf(data: unknown): string {
  return (data as Partial<TabDragData> | undefined)?.title ?? "Tab";
}

function dropOverOf(over: Over | null): DropOver | null {
  if (over === null) return null;
  const data = over.data.current as Partial<TabDragData> | ContentDropData | undefined;
  if (data?.kind === "content") return { kind: "content", pane: data.pane, rect: over.rect };
  if (data?.kind === "tab") return { kind: "tab", id: String(over.id), rect: over.rect };
  return null;
}

/** Records a press before it activates its tab; each pane hands it to its strip. */
export const NotePressContext = createContext<(surfaceId: string) => void>(() => {});

const ANNOUNCEMENTS: Announcements = {
  onDragStart: ({ active }) => `Picked up ${titleOf(active.data.current)}.`,
  onDragOver: ({ active, over }) =>
    over ? `${titleOf(active.data.current)} is over a drop target.` : undefined,
  onDragEnd: ({ active, over }) =>
    over
      ? `${titleOf(active.data.current)} was dropped.`
      : `${titleOf(active.data.current)} was put back.`,
  onDragCancel: ({ active }) => `Moving ${titleOf(active.data.current)} was cancelled.`,
};

/**
 * One drag context around every strip and pane of a ChatView panel, so a tab can be reordered,
 * moved to the other pane, or dropped on content to split. Drag state renders only the chip and
 * the ghost, never a surface.
 */
export function RightPanelDragScope(props: {
  readonly threadRef: ScopedThreadRef;
  readonly splitAllowed: boolean;
  readonly splitRendered: boolean;
  readonly splitGrowth: number;
  /** Applies a drop's layout change; the split view owns what a change does beyond the store. */
  readonly applyChange: (change: SplitChange) => void;
  readonly children: ReactNode;
}) {
  const { threadRef } = props;
  const sensors = useTabDragSensors();
  const [session, setSession] = useState<{ title: string; plan: DropPlan | null } | null>(null);
  const press = useRef<{ surfaceId: string; restoreShown: string | null } | null>(null);
  // The latest pointer, as collision detection last saw it. An event's `delta` would not do:
  // dnd-kit adds the tab strip's auto-scroll to it.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const readThread = () =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);

  const notePress = (surfaceId: string) => {
    const thread = readThread();
    const layout = paneLayout(thread);
    const shown =
      layout.kind === "split" ? layout[paneOf(thread, surfaceId)].shown.id : thread.activeSurfaceId;
    press.current = { surfaceId, restoreShown: shown === surfaceId ? null : shown };
  };

  const collisionDetection: CollisionDetection = (args) => {
    pointer.current = args.pointerCoordinates;
    return panelCollision(args);
  };

  const planFor = (event: DragMoveEvent | DragEndEvent): DropPlan | null => {
    const draggedId = String(event.active.id);
    return resolveDrop({
      arrangement: readThread(),
      splitRendered: props.splitRendered,
      splitAllowed: props.splitAllowed,
      draggedId,
      over: dropOverOf(event.over),
      pointer: pointer.current,
      restoreShown: press.current?.surfaceId === draggedId ? press.current.restoreShown : null,
      splitGrowth: props.splitGrowth,
    });
  };

  // `over` also changes without a move, once droppables are measured or a strip scrolls.
  const updatePlan = (event: DragMoveEvent) => {
    const plan = planFor(event);
    setSession((current) =>
      current === null || samePlan(current.plan, plan) ? current : { ...current, plan },
    );
  };

  const finish = () => {
    press.current = null;
    pointer.current = null;
    setSession(null);
  };

  return (
    <NotePressContext value={notePress}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        autoScroll={AUTO_SCROLL}
        accessibility={{ announcements: ANNOUNCEMENTS }}
        onDragStart={({ active, activatorEvent }: DragStartEvent) => {
          // A touch drag starts without a press activation, so an older press record is stale.
          const pressed =
            activatorEvent instanceof PointerEvent && activatorEvent.pointerType !== "touch";
          if (!pressed || press.current?.surfaceId !== active.id) press.current = null;
          setSession({ title: titleOf(active.data.current), plan: null });
        }}
        onDragMove={updatePlan}
        onDragOver={updatePlan}
        onDragEnd={(event) => {
          const plan = planFor(event);
          finish();
          if (plan) props.applyChange(plan.change);
        }}
        onDragCancel={finish}
      >
        {props.children}
        {createPortal(
          <>
            <DragOverlay dropAnimation={null} zIndex={60}>
              {session ? (
                <div className="flex h-6 max-w-36 items-center rounded-md bg-accent px-2 text-xs text-foreground shadow-md">
                  <span className="truncate">{session.title}</span>
                </div>
              ) : null}
            </DragOverlay>
            {/* Code views and hosted browser pages under the pointer must not see the drag. */}
            {session ? (
              <div
                aria-hidden
                data-right-panel-drag-shield
                className="fixed inset-0 z-40 cursor-grabbing"
              />
            ) : null}
            {session?.plan?.ghost ? <DropGhostView ghost={session.plan.ghost} /> : null}
          </>,
          document.body,
        )}
      </DndContext>
    </NotePressContext>
  );
}

function DropGhostView({ ghost }: { ghost: DropGhost }) {
  if (ghost.kind === "marker") {
    return (
      <div
        aria-hidden
        data-right-panel-drop-ghost="marker"
        className="pointer-events-none fixed z-[70] w-0.5 rounded-full bg-primary"
        style={{ left: ghost.left, top: ghost.top, height: ghost.height }}
      />
    );
  }
  return (
    <div
      aria-hidden
      data-right-panel-drop-ghost="box"
      className="pointer-events-none fixed z-50 rounded-md bg-primary/15 ring-2 ring-primary/45 ring-inset"
      style={{ left: ghost.left, top: ghost.top, width: ghost.width, height: ghost.height }}
    />
  );
}
