import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
import {
  CornerDownRightIcon,
  InboxIcon,
  MaximizeIcon,
  MessageSquareIcon,
  MinusIcon,
  PlusIcon,
  SendIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { withoutAssistantCitationHash } from "~/lib/assistantCitationNavigation";
import { openSideThread, threadLinkProps } from "~/lib/sideChatPane";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { useAssistantMessageText, useQuietThreadShell } from "~/state/entities";
import { selectThreadPanelOpen, useRightPanelStore } from "~/rightPanelStore";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useThreadMapViewStore } from "~/threadMapViewStore";
import {
  fitFleetLayout,
  type FleetRect,
  type FleetViewTransform,
  zoomFleetView,
} from "../settings/environmentsMap.logic";
import { ThreadContextChip } from "../ThreadContextChip";
import { Button } from "../ui/button";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { useChatCanvas } from "./ChatCanvasContext";
import { readTimelinePosition, rememberTimelinePosition } from "./timelineScrollAnchoring";
import { ThreadRelationshipIcon, threadRelationshipStatusLabel } from "./ThreadRelationshipIcon";
import {
  deriveThreadMap,
  isActiveThreadMapTurn,
  layoutThreadMap,
  threadMapInitialView,
  type ThreadMapAgent,
  type ThreadMapArrow,
  type ThreadMapColumn,
  type ThreadMapInput,
  type ThreadMapLayout,
  type ThreadMapOutput,
  type ThreadMapSender,
  type ThreadMapTurn,
} from "./threadMap.logic";

type GT = ReturnType<typeof useGT>;

type ThreadMapSelection =
  | { readonly kind: "turn"; readonly turn: ThreadMapTurn }
  | {
      readonly kind: "agent";
      readonly agent: ThreadMapAgent;
      readonly returnTurn: ThreadMapTurn | null;
    };

/** What makes a card or agent one of the map's selectable, keyboard-reachable buttons. */
interface MapNodeProps {
  readonly type: "button";
  readonly "data-thread-map-item": "";
  readonly "data-thread-map-node": string;
  readonly "aria-pressed": boolean;
  readonly tabIndex: number;
  readonly style: CSSProperties;
  readonly onClick: () => void;
  readonly onFocus: (event: FocusEvent<HTMLElement>) => void;
}

const turnNodeId = (turn: ThreadMapTurn) => `turn:${turn.runId}`;

const firstLine = (text: string) => text.trim().split(/\r?\n/, 1)[0] ?? "";

const NODE_CLASS =
  "absolute flex cursor-pointer items-center text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-pressed:ring-2 aria-pressed:ring-primary aria-pressed:ring-inset forced-colors:focus-visible:outline-2 forced-colors:aria-pressed:outline-2";

const EDGE_CLASS: Record<"spine" | "input" | "output" | "return", string> = {
  spine: "text-foreground/25",
  input: "text-foreground/40",
  output: "text-foreground/40",
  return: "text-info",
};

const sameView = (left: FleetViewTransform, right: FleetViewTransform) =>
  left.scale === right.scale && left.x === right.x && left.y === right.y;

const rectStyle = (rect: FleetRect): CSSProperties => ({
  left: rect.x,
  top: rect.y,
  width: rect.width,
  height: rect.height,
});

/** The current thread as a map of its turns. Lazy: it adds nothing until a thread shows it. */
export default function ThreadMap({
  threadRef,
  projection,
  bottomInset,
}: {
  readonly threadRef: ScopedThreadRef;
  /** The thread's quiet structure, or null while it loads. */
  readonly projection: ThreadStructure | null;
  /** The composer floats over the bottom of the chat column. */
  readonly bottomInset: number;
}) {
  const gt = useGT();
  const [selected, setSelected] = useState<string | null>(null);
  const rightInset = useDetailsCardInset(threadRef);
  if (projection === null) {
    return (
      <ThreadMapNotice bottomInset={bottomInset}>{gt("Loading the thread map…")}</ThreadMapNotice>
    );
  }
  const turns = deriveThreadMap(projection);
  if (turns.length === 0) {
    return (
      <ThreadMapNotice bottomInset={bottomInset}>
        {gt("No turns yet. Send a message and each turn appears here.")}
      </ThreadMapNotice>
    );
  }
  const layout = layoutThreadMap(turns);
  const selection = findSelection(turns, selected);
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      style={{ paddingBottom: bottomInset, paddingRight: rightInset }}
    >
      <ThreadMapCanvas
        threadRef={threadRef}
        turns={turns}
        layout={layout}
        selected={selection === null ? null : selected}
        onSelect={setSelected}
      />
      <ThreadMapDetails
        threadRef={threadRef}
        turnCount={turns.length}
        selection={selection}
        onClear={() => setSelected(null)}
      />
    </div>
  );
}

/** How much of the canvas's right edge the open inline thread details card covers. */
function useDetailsCardInset(threadRef: ScopedThreadRef) {
  const placement = useChatCanvas()?.detailsCardPlacement ?? null;
  const open = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "inline"),
  );
  return open && placement !== null ? placement.width + placement.right * 2 : 0;
}

function findSelection(
  turns: ReadonlyArray<ThreadMapTurn>,
  id: string | null,
): ThreadMapSelection | null {
  if (id === null) return null;
  for (const turn of turns) {
    if (turnNodeId(turn) === id) return { kind: "turn", turn };
    for (const output of turn.outputs) {
      if (output.kind !== "agent" || output.id !== id) continue;
      const { returnRunId } = output.agent;
      return {
        kind: "agent",
        agent: output.agent,
        returnTurn: turns.find((candidate) => candidate.runId === returnRunId) ?? null,
      };
    }
  }
  return null;
}

function ThreadMapNotice({
  bottomInset,
  children,
}: {
  readonly bottomInset: number;
  readonly children: ReactNode;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground"
      style={{ paddingBottom: bottomInset }}
    >
      <p>{children}</p>
    </div>
  );
}

function ThreadMapCanvas({
  threadRef,
  turns,
  layout,
  selected,
  onSelect,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly turns: ReadonlyArray<ThreadMapTurn>;
  readonly layout: ThreadMapLayout;
  readonly selected: string | null;
  readonly onSelect: (id: string | null) => void;
}) {
  const gt = useGT();
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ readonly width: number; readonly height: number } | null>(
    null,
  );
  // A view set by hand holds while the thread grows; without one the newest turns stay in view.
  const [manual, setManual] = useState<{
    readonly view: FleetViewTransform | null;
    readonly glide: boolean;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
    readonly origin: FleetViewTransform;
    moved: boolean;
  } | null>(null);
  const initial = size === null ? null : threadMapInitialView(layout, size);
  const view = manual?.view ?? initial;
  const glide = manual?.glide === true;
  const setView = (next: FleetViewTransform, eased: boolean) =>
    setManual({ view: next, glide: eased });
  const zoom = (
    factor: number,
    anchor?: { readonly x: number; readonly y: number },
    eased = true,
  ) => {
    if (view === null || size === null) return;
    setView(
      zoomFleetView(
        view,
        factor,
        anchor ?? { x: size.width / 2, y: size.height / 2 },
        fitFleetLayout(layout, size).scale,
      ),
      eased,
    );
  };
  // The opening view can show only the newest turns of a long map; Fit shows all of it.
  const fitted = size === null ? null : fitFleetLayout(layout, size);
  const isFitted = view !== null && fitted !== null && sameView(view, fitted);
  const fit = () => {
    if (fitted === null || initial === null || isFitted) return;
    // When the opening view is the whole map, return to it so new turns stay in view.
    if (sameView(initial, fitted)) setManual({ view: null, glide: true });
    else setView(fitted, true);
  };
  const onWheel = useEffectEvent((event: WheelEvent) => {
    if (view === null) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
      zoom(
        Math.exp(-event.deltaY * 0.01),
        { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
        false,
      );
      return;
    }
    // Nothing scrolls behind the map, so a plain wheel or trackpad swipe pans it.
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
    setView({ ...view, x: view.x - event.deltaX * unit, y: view.y - event.deltaY * unit }, false);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the canvas with ResizeObserver, and React's wheel listener is passive so it cannot stop the page zooming
  useEffect(() => {
    if (canvas === null) return;
    const stopObserving = observeResize(canvas, ([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      stopObserving();
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [canvas]);

  // Reads the view inside the updater so the scene's props stay the same while panning.
  const reveal = useStableCallback((rect: FleetRect) => {
    if (size === null || initial === null) return;
    setManual((current) => {
      const shown = current?.view ?? initial;
      const left = rect.x * shown.scale + shown.x;
      const top = rect.y * shown.scale + shown.y;
      const inside =
        left >= 0 &&
        top >= 0 &&
        left + rect.width * shown.scale <= size.width &&
        top + rect.height * shown.scale <= size.height;
      if (inside) return current;
      return {
        glide: true,
        view: {
          scale: shown.scale,
          x: size.width / 2 - (rect.x + rect.width / 2) * shown.scale,
          y: size.height / 2 - (rect.y + rect.height / 2) * shown.scale,
        },
      };
    });
  });

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || view === null || drag.current !== null) return;
    if ((event.target as Element).closest("[data-thread-map-item]")) return;
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      origin: view,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.moved && Math.hypot(dx, dy) < 4) return;
    current.moved = true;
    setDragging(true);
    setView({ ...current.origin, x: current.origin.x + dx, y: current.origin.y + dy }, false);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (!cancelled && !current.moved) onSelect(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "+" || event.key === "=") zoom(1.25);
    else if (event.key === "-") zoom(0.8);
    else if (event.key === "0") fit();
    else if (event.key === "Escape" && selected !== null) {
      // Deselecting is all this Esc does; nothing around the map should act on it too.
      event.stopPropagation();
      onSelect(null);
    } else return;
    event.preventDefault();
  };

  return (
    <>
      <div
        ref={setCanvas}
        data-dragging={dragging || undefined}
        data-glide={glide || undefined}
        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-clip select-none data-dragging:cursor-grabbing data-glide:transition-[background-size,background-position] data-glide:duration-200 data-glide:ease-out motion-reduce:transition-none"
        style={
          view === null
            ? undefined
            : {
                backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1.5px)",
                backgroundSize: `${24 * view.scale}px ${24 * view.scale}px`,
                backgroundPosition: `${view.x}px ${view.y}px`,
              }
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endDrag(event, false)}
        onPointerCancel={(event) => endDrag(event, true)}
        onLostPointerCapture={(event) => endDrag(event, true)}
        // Safari does not focus a clicked button, so its keys would skip the map.
        onClick={(event) =>
          (event.target as Element)
            .closest<HTMLElement>("button[data-thread-map-item]")
            ?.focus({ preventScroll: true })
        }
        onKeyDown={onKeyDown}
      >
        {view === null ? null : (
          <div
            className="absolute top-0 left-0 origin-top-left in-data-dragging:will-change-transform in-data-glide:transition-transform in-data-glide:duration-200 in-data-glide:ease-out motion-reduce:transition-none"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
          >
            <ThreadMapScene
              threadRef={threadRef}
              turns={turns}
              layout={layout}
              selected={selected}
              onSelect={onSelect}
              onReveal={reveal}
            />
          </div>
        )}
      </div>
      {/* Below the canvas, not over it: nothing on the map can end up under the controls. */}
      <div className="flex items-center justify-end gap-3 border-t border-border/60 px-3 py-1">
        <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-popover/90 p-0.5 shadow-xs/5">
          <SharedTooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={gt("Zoom out")}
                onClick={() => zoom(0.8)}
              />
            }
            label={gt("Zoom out")}
          >
            <MinusIcon />
          </SharedTooltipTrigger>
          <SharedTooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={gt("Zoom in")}
                onClick={() => zoom(1.25)}
              />
            }
            label={gt("Zoom in")}
          >
            <PlusIcon />
          </SharedTooltipTrigger>
          <SharedTooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={gt("Fit the map to view")}
                disabled={isFitted}
                onClick={fit}
              />
            }
            label={gt("Fit the map to view")}
          >
            <MaximizeIcon />
          </SharedTooltipTrigger>
        </div>
      </div>
    </>
  );
}

const columnTitle = (column: ThreadMapColumn, gt: GT) =>
  column === "inputs"
    ? gt("Into the turn", { $context: "thread map column: steers and messages a turn received" })
    : column === "turns"
      ? gt("Turns", { $context: "thread map column: one card per prompt" })
      : gt("Out of the turn", {
          $context: "thread map column: agents and messages a turn started",
        });

function arrowPath({ x, y, dir }: ThreadMapArrow) {
  return `M${x - dir * 7} ${y - 4}L${x} ${y}L${x - dir * 7} ${y + 4}Z`;
}

function ThreadMapScene({
  threadRef,
  turns,
  layout,
  selected,
  onSelect,
  onReveal,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly turns: ReadonlyArray<ThreadMapTurn>;
  readonly layout: ThreadMapLayout;
  readonly selected: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly onReveal: (rect: FleetRect) => void;
}) {
  const gt = useGT();
  const order = turns.flatMap((turn) => [
    turnNodeId(turn),
    ...turn.outputs.flatMap((output) => (output.kind === "agent" ? [output.id] : [])),
  ]);
  const [roving, setRoving] = useState<string | null>(null);
  const tabStop =
    roving !== null && order.includes(roving) ? roving : (selected ?? order.at(-1) ?? null);
  const rects = new Map<string, FleetRect>(layout.items);
  for (const turn of turns) {
    const card = layout.turns.get(turn.runId);
    if (card !== undefined) rects.set(turnNodeId(turn), card);
  }
  const nodeProps = (id: string, rect: FleetRect): MapNodeProps => ({
    type: "button",
    "data-thread-map-item": "",
    "data-thread-map-node": id,
    "aria-pressed": selected === id,
    tabIndex: id === tabStop ? 0 : -1,
    style: rectStyle(rect),
    onClick: () => onSelect(selected === id ? null : id),
    onFocus: (event: FocusEvent<HTMLElement>) => {
      setRoving(id);
      // Tabbing back in can land on a card panned out of view; a click cannot.
      if (event.currentTarget.matches(":focus-visible")) onReveal(rect);
    },
  });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    const from = (event.target as HTMLElement).closest<HTMLElement>("[data-thread-map-node]");
    if (step === 0 || from === null) return;
    event.preventDefault();
    const next = order[order.indexOf(from.dataset.threadMapNode ?? "") + step];
    const rect = next === undefined ? undefined : rects.get(next);
    if (next === undefined || rect === undefined) return;
    event.currentTarget
      .querySelector<HTMLElement>(`[data-thread-map-node="${CSS.escape(next)}"]`)
      ?.focus({ preventScroll: true });
    onReveal(rect);
  };

  return (
    <div
      role="group"
      aria-label={gt("Map of this thread")}
      aria-description={gt(
        "Arrow keys move between turns and the agents they started. Enter shows the details below the map. Plus and minus zoom, zero fits the map.",
      )}
      onKeyDown={onKeyDown}
    >
      {layout.columns.map((column) => (
        <p
          key={column.id}
          aria-hidden
          style={{ left: column.x }}
          className="absolute top-0 text-2xs font-medium whitespace-nowrap text-muted-foreground"
        >
          {columnTitle(column.id, gt)}
        </p>
      ))}
      <svg
        width={layout.width}
        height={layout.height}
        className="pointer-events-none absolute top-0 left-0 overflow-visible"
        fill="none"
        strokeLinecap="round"
        aria-hidden
      >
        {layout.edges.map((edge) => (
          <g key={edge.id} className={EDGE_CLASS[edge.kind]}>
            <path
              d={edge.d}
              stroke="currentColor"
              strokeWidth={edge.kind === "return" ? 1.5 : 1.25}
              strokeDasharray={edge.kind === "return" ? "4 3" : undefined}
            />
            {edge.arrow === null ? null : <path d={arrowPath(edge.arrow)} fill="currentColor" />}
          </g>
        ))}
      </svg>
      {turns.map((turn) => {
        const card = layout.turns.get(turn.runId);
        if (card === undefined) return null;
        return (
          <div key={turn.runId}>
            <TurnCard threadRef={threadRef} turn={turn} node={nodeProps(turnNodeId(turn), card)} />
            {turn.inputs.map((input) => {
              const rect = layout.items.get(input.id);
              return rect === undefined ? null : (
                <InputItem
                  key={input.id}
                  environmentId={threadRef.environmentId}
                  input={input}
                  rect={rect}
                />
              );
            })}
            {turn.outputs.map((output) => {
              const rect = layout.items.get(output.id);
              if (rect === undefined) return null;
              return output.kind === "agent" ? (
                <AgentNode
                  key={output.id}
                  environmentId={threadRef.environmentId}
                  agent={output.agent}
                  node={nodeProps(output.id, rect)}
                />
              ) : (
                <SendItem
                  key={output.id}
                  environmentId={threadRef.environmentId}
                  send={output}
                  rect={rect}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function useSenderTitle(environmentId: EnvironmentId, sender: ThreadMapSender | null) {
  const shell = useQuietThreadShell(
    sender?.kind === "local" ? scopeThreadRef(environmentId, sender.threadId) : null,
  );
  return sender?.kind === "linked"
    ? sender.sender.title.trim() || null
    : shell?.title.trim() || null;
}

function turnKindLabel(sender: ThreadMapSender | null, senderTitle: string | null, gt: GT) {
  if (sender === null) return gt("Prompt", { $context: "thread map: a turn the user started" });
  return senderTitle === null
    ? gt("Message from another thread")
    : gt("Message from {thread}", { thread: senderTitle });
}

function TurnCard({
  threadRef,
  turn,
  node,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly turn: ThreadMapTurn;
  readonly node: MapNodeProps;
}) {
  const gt = useGT();
  const m = useMessages();
  const senderTitle = useSenderTitle(threadRef.environmentId, turn.sender);
  const update = useAssistantMessageText(threadRef, turn.updateItemId ?? undefined);
  const title = firstLine(turn.prompt) || gt("Turn {number}", { number: turn.number });
  const kind = turnKindLabel(turn.sender, senderTitle, gt);
  const status = threadRelationshipStatusLabel(turn.status, m);
  const meta = turnMeta(turn, gt, m);
  return (
    <button
      {...node}
      aria-label={[gt("Turn {number}", { number: turn.number }), kind, title, status].join(", ")}
      className={cn(
        NODE_CLASS,
        "flex-col items-stretch justify-center gap-0.5 rounded-lg border bg-card px-2.5 text-card-foreground shadow-sm/5 hover:border-foreground/45",
        turn.queued ? "border-dashed border-foreground/25 opacity-75" : "border-foreground/20",
      )}
    >
      <span className="flex items-center gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted forced-colors:border">
          <ThreadRelationshipIcon
            status={turn.status}
            fallbackIcon={turn.sender === null ? MessageSquareIcon : InboxIcon}
          />
        </span>
        <span className="min-w-0 flex-1 truncate text-2xs leading-4 text-muted-foreground">
          <span className="font-medium text-foreground/80 tabular-nums">
            {gt("Turn {number}", { number: turn.number })}
          </span>
          {` · ${turn.queued ? status : kind}`}
        </span>
      </span>
      <span className="truncate text-xs leading-4 font-semibold">{title}</span>
      {turn.queued ? null : (
        <>
          <span className="truncate text-2xs leading-4 text-muted-foreground">
            {update === null ? null : firstLine(update)}
          </span>
          <span className="truncate text-2xs leading-4 text-muted-foreground tabular-nums">
            {meta.join(" · ")}
          </span>
        </>
      )}
    </button>
  );
}

function turnMeta(turn: ThreadMapTurn, gt: GT, m: ReturnType<typeof useMessages>) {
  return [
    turn.moreToolCalls
      ? gt("{count}+ tool calls", { count: turn.toolCalls })
      : gt("{count, plural, one {{count} tool call} other {{count} tool calls}}", {
          count: turn.toolCalls,
        }),
    ...(turn.filesChanged === null
      ? []
      : [
          gt("{count, plural, one {{count} file changed} other {{count} files changed}}", {
            count: turn.filesChanged,
          }),
        ]),
    ...(turn.durationMs === null ? [] : [formatDuration(turn.durationMs, m)]),
  ];
}

function LaneItem({
  rect,
  icon,
  label,
  detail,
  link,
}: {
  readonly rect: FleetRect;
  readonly icon: ReactNode;
  readonly label: string;
  readonly detail: string;
  readonly link?: ReturnType<typeof threadLinkProps> | undefined;
}) {
  const box = {
    style: rectStyle(rect),
    className:
      "absolute flex items-center gap-2 rounded-md border border-border bg-card/80 px-2 text-foreground/90",
  };
  return (
    <SharedTooltipTrigger
      render={
        link === undefined ? (
          <div {...box} />
        ) : (
          // The turn's details list the same thread as a focusable chip, so the card stays out of the tab order.
          <Link
            {...link}
            {...box}
            data-thread-map-item=""
            tabIndex={-1}
            draggable={false}
            className={cn(box.className, "cursor-pointer hover:border-foreground/45")}
          />
        )
      }
      label={detail}
      disabled={detail === ""}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-2xs leading-4 font-medium">{label}</span>
        <span className="block truncate text-2xs leading-4 text-muted-foreground">{detail}</span>
      </span>
    </SharedTooltipTrigger>
  );
}

function InputItem({
  environmentId,
  input,
  rect,
}: {
  readonly environmentId: EnvironmentId;
  readonly input: ThreadMapInput;
  readonly rect: FleetRect;
}) {
  const gt = useGT();
  const senderTitle = useSenderTitle(environmentId, input.sender);
  if (input.kind === "incoming") {
    return (
      <LaneItem
        rect={rect}
        icon={<InboxIcon aria-hidden className="size-3.5" />}
        label={gt("Message from", { $context: "thread map: precedes the sending thread's name" })}
        detail={senderTitle ?? gt("Another thread")}
      />
    );
  }
  return (
    <LaneItem
      rect={rect}
      icon={<CornerDownRightIcon aria-hidden className="size-3.5" />}
      label={
        input.sender === null
          ? gt("Steer", { $context: "thread map: a message sent while the turn ran" })
          : senderTitle === null
            ? gt("Steer from another thread")
            : gt("Steer from {thread}", { thread: senderTitle })
      }
      detail={firstLine(input.text)}
    />
  );
}

function SendItem({
  environmentId,
  send,
  rect,
}: {
  readonly environmentId: EnvironmentId;
  readonly send: Extract<ThreadMapOutput, { readonly kind: "send" }>;
  readonly rect: FleetRect;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const targetRef = send.threadId === null ? null : scopeThreadRef(environmentId, send.threadId);
  const target = useQuietThreadShell(targetRef);
  return (
    <LaneItem
      rect={rect}
      icon={<SendIcon aria-hidden className="size-3.5" />}
      label={gt("Sent a message")}
      detail={target?.title.trim() ?? ""}
      link={targetRef === null ? undefined : threadLinkProps(targetRef, target, navigate)}
    />
  );
}

function useAgentTitle(environmentId: EnvironmentId, agent: ThreadMapAgent) {
  const gt = useGT();
  const child = useQuietThreadShell(
    agent.childThreadId === null ? null : scopeThreadRef(environmentId, agent.childThreadId),
  );
  return (
    agent.title ??
    (child?.title.trim() || firstLine(agent.prompt) || gt("Agent", { $context: "a subagent" }))
  );
}

function AgentNode({
  environmentId,
  agent,
  node,
}: {
  readonly environmentId: EnvironmentId;
  readonly agent: ThreadMapAgent;
  readonly node: MapNodeProps;
}) {
  const m = useMessages();
  const title = useAgentTitle(environmentId, agent);
  const status = threadRelationshipStatusLabel(agent.status, m);
  const detail = [agent.model === null ? null : formatModelSlugName(agent.model), status]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <button
      {...node}
      aria-label={`${title}, ${detail}`}
      className={cn(
        NODE_CLASS,
        "gap-2 rounded-md border border-foreground/20 bg-card px-2 text-foreground/90 hover:border-foreground/45",
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        <ThreadRelationshipIcon driver={agent.driver} status={agent.status} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-2xs leading-4 font-medium">{title}</span>
        <span className="block truncate text-2xs leading-4 text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}

function DetailSection({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="min-w-0">
      <h4 className="mb-0.5 text-2xs font-medium text-muted-foreground">{label}</h4>
      <div className="text-xs whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
        {children}
      </div>
    </section>
  );
}

function ThreadMapDetails({
  threadRef,
  turnCount,
  selection,
  onClear,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly turnCount: number;
  readonly selection: ThreadMapSelection | null;
  readonly onClear: () => void;
}) {
  const gt = useGT();
  return (
    <div
      role="group"
      aria-label={gt("Details")}
      tabIndex={-1}
      // Shrinks and scrolls before the canvas gives up its minimum height.
      className="max-h-[45%] min-h-0 overflow-y-auto border-t border-border/60 px-3 py-2.5 text-xs outline-none sm:px-4"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || selection === null) return;
        event.stopPropagation();
        event.preventDefault();
        onClear();
      }}
    >
      {selection === null ? (
        <p className="text-muted-foreground">
          {gt(
            "{count, plural, one {{count} turn.} other {{count} turns.}} Select a turn or an agent to see what happened.",
            { count: turnCount },
          )}
        </p>
      ) : selection.kind === "turn" ? (
        <TurnDetails key={selection.turn.runId} threadRef={threadRef} turn={selection.turn} />
      ) : (
        <AgentDetails
          key={selection.agent.id}
          threadRef={threadRef}
          agent={selection.agent}
          returnTurn={selection.returnTurn}
        />
      )}
    </div>
  );
}

function TurnDetails({
  threadRef,
  turn,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly turn: ThreadMapTurn;
}) {
  const gt = useGT();
  const m = useMessages();
  const senderTitle = useSenderTitle(threadRef.environmentId, turn.sender);
  const update = useAssistantMessageText(threadRef, turn.updateItemId ?? undefined);
  const answer = useAssistantMessageText(threadRef, turn.answerItemId ?? undefined);
  const setThreadMapShown = useThreadMapViewStore((state) => state.setThreadMapShown);
  const router = useRouter();
  const steers = turn.inputs.flatMap((input) => (input.kind === "steer" ? [input] : []));
  const sentTo = turn.outputs.flatMap((output) => (output.kind === "send" ? [output] : []));
  const agents = turn.outputs.length - sentTo.length;
  const showInConversation = async () => {
    // The timeline restores to a remembered row when it mounts, so the turn opens in view.
    const key = scopedThreadKey(threadRef);
    const remembered = readTimelinePosition(key);
    rememberTimelinePosition(
      key,
      {
        ...(turn.rowId === null
          ? // Only the oldest loaded turn can open before the window, so it starts at the top.
            { rowId: "", offsetWithinRow: 0, scrollOffset: 0 }
          : {
              rowId: turn.rowId,
              offsetWithinRow: -16,
              // Where the timeline was, should the turn's row be folded away.
              scrollOffset: remembered?.scrollOffset ?? 0,
            }),
        atEnd: false,
        ...(remembered?.disclosures === undefined ? {} : { disclosures: remembered.disclosures }),
      },
      false,
    );
    // A citation already shown stays in the URL, and a remounted conversation would reveal it again.
    const href = router.state.location.href;
    const plain = withoutAssistantCitationHash(href);
    if (plain !== href) await router.navigate({ href: plain, replace: true });
    setThreadMapShown(threadRef, false);
  };
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="text-sm font-medium text-foreground">
          {gt("Turn {number}", { number: turn.number })}
        </h3>
        <span className="text-muted-foreground">
          {`${turnKindLabel(turn.sender, senderTitle, gt)} · ${threadRelationshipStatusLabel(turn.status, m)}`}
        </span>
        <Button
          className="ms-auto"
          size="xs"
          variant="outline"
          disabled={turn.queued}
          onClick={showInConversation}
        >
          {gt("Show in conversation")}
        </Button>
      </div>
      <DetailSection label={gt("Prompt", { $context: "thread map: a turn the user started" })}>
        {turn.prompt}
      </DetailSection>
      {turn.queued ? null : (
        <>
          {update === null ? null : (
            <DetailSection label={gt("Agent update")}>{update}</DetailSection>
          )}
          <DetailSection label={gt("What it did")}>
            {[
              ...turnMeta(turn, gt, m),
              ...(agents === 0
                ? []
                : [
                    gt("{count, plural, one {{count} agent} other {{count} agents}}", {
                      count: agents,
                    }),
                  ]),
              ...(sentTo.length === 0
                ? []
                : [
                    gt(
                      "{count, plural, one {{count} message sent} other {{count} messages sent}}",
                      {
                        count: sentTo.length,
                      },
                    ),
                  ]),
            ].join(" · ")}
          </DetailSection>
          {steers.length === 0 ? null : (
            <DetailSection
              label={gt("Steers", { $context: "thread map: messages sent while a turn ran" })}
            >
              <ul className="space-y-1">
                {steers.map((steer) => (
                  <SteerLine key={steer.id} environmentId={threadRef.environmentId} steer={steer} />
                ))}
              </ul>
            </DetailSection>
          )}
          {sentTo.length === 0 ? null : (
            <DetailSection label={gt("Messages sent")}>
              <ul className="space-y-1">
                {sentTo.map((send) => (
                  <SendTargetLine
                    key={send.id}
                    environmentId={threadRef.environmentId}
                    send={send}
                  />
                ))}
              </ul>
            </DetailSection>
          )}
          <DetailSection label={gt("Answer")}>
            {answer ??
              (isActiveThreadMapTurn(turn) ? gt("Still working…") : gt("No answer in this turn."))}
          </DetailSection>
        </>
      )}
    </div>
  );
}

function SteerLine({
  environmentId,
  steer,
}: {
  readonly environmentId: EnvironmentId;
  readonly steer: Extract<ThreadMapInput, { readonly kind: "steer" }>;
}) {
  const gt = useGT();
  const senderTitle = useSenderTitle(environmentId, steer.sender);
  return (
    <li>
      {steer.sender === null ? null : (
        <span className="block text-muted-foreground">
          {senderTitle === null
            ? gt("Steer from another thread")
            : gt("Steer from {thread}", { thread: senderTitle })}
        </span>
      )}
      {steer.text}
    </li>
  );
}

function SendTargetLine({
  environmentId,
  send,
}: {
  readonly environmentId: EnvironmentId;
  readonly send: Extract<ThreadMapOutput, { readonly kind: "send" }>;
}) {
  const gt = useGT();
  const target = useQuietThreadShell(
    send.threadId === null ? null : scopeThreadRef(environmentId, send.threadId),
  );
  return (
    <li>
      {send.threadId === null ? (
        gt("Another thread")
      ) : (
        <ThreadContextChip
          record={{
            environmentId,
            threadId: send.threadId,
            title: target?.title.trim() || gt("Another thread"),
          }}
          projectId={target?.projectId ?? null}
        />
      )}
    </li>
  );
}

function AgentDetails({
  threadRef,
  agent,
  returnTurn,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly agent: ThreadMapAgent;
  readonly returnTurn: ThreadMapTurn | null;
}) {
  const gt = useGT();
  const m = useMessages();
  const navigate = useNavigate();
  const title = useAgentTitle(threadRef.environmentId, agent);
  const active =
    agent.status === "pending" || agent.status === "running" || agent.status === "waiting";
  const childThreadId = agent.childThreadId;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="min-w-0 truncate text-sm font-medium text-foreground">{title}</h3>
        <span className="text-muted-foreground">
          {[
            agent.model === null ? null : formatModelSlugName(agent.model),
            threadRelationshipStatusLabel(agent.status, m),
          ]
            .filter((part) => part !== null)
            .join(" · ")}
        </span>
        {childThreadId === null ? null : (
          <Button
            className="ms-auto"
            size="xs"
            variant="outline"
            onClick={() =>
              openSideThread({
                threadRef: scopeThreadRef(threadRef.environmentId, childThreadId),
                panelRef: threadRef,
                intent: "primary",
                navigate: (ref) =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(ref),
                  }),
              })
            }
          >
            {gt("Open thread")}
          </Button>
        )}
      </div>
      <DetailSection label={gt("Prompt", { $context: "thread map: what an agent was asked" })}>
        {agent.prompt}
      </DetailSection>
      {agent.progress === null ? null : (
        <DetailSection label={gt("Progress")}>{agent.progress}</DetailSection>
      )}
      <DetailSection label={gt("Result")}>
        {agent.result ?? (active ? gt("Still working…") : gt("No result."))}
      </DetailSection>
      {returnTurn === null ? null : (
        <p className="text-muted-foreground">
          <T>
            Its result came back into turn <Var>{returnTurn.number}</Var>, where the dashed line
            ends.
          </T>
        </p>
      )}
    </div>
  );
}
