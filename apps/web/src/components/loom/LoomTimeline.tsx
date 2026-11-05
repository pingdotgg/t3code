import type { LoomLaneActivity, LoomRow } from "@t3tools/client-runtime/projectLoom";
import { loomEdgeLabel, loomMarkerLabel } from "@t3tools/client-runtime/projectLoom";
import type { LoomEdge, LoomMarker, LoomRun, LoomWindow } from "@t3tools/contracts";
import { BotIcon, ChevronDownIcon, ChevronRightIcon, GitForkIcon, UnlinkIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import {
  ACTIVE_RUN,
  formatLoomTick,
  formatLoomTime,
  loomScale,
  loomTicks,
  type LoomView,
} from "./loomScale";
import type { LoomSelection } from "./loomSearch";
import { loomMarkerKey } from "./loomWeave";
import { useLoomViewGestures } from "./useLoomViewGestures";

const LOOM_ROW_HEIGHT = 28;
// Lane labels take up to this much, and never more than 40% of a narrow timeline.
const MAX_LABEL_WIDTH = 248;
const AXIS_HEIGHT = 24;
const OVERSCAN_ROWS = 6;
const MARK_SIZE = 4;

const RUN_STATUS_CLASS: Record<LoomRun["status"], string> = {
  preparing: "fill-primary/60",
  queued: "fill-primary/60",
  starting: "fill-primary/60",
  running: "fill-primary/70",
  waiting: "fill-warning/70",
  completed: "fill-muted-foreground/45",
  interrupted: "fill-warning/60",
  cancelled: "fill-muted-foreground/30",
  rolled_back: "fill-muted-foreground/30",
  failed: "fill-destructive/70",
};

const PRE_EXECUTION_RUN = new Set<LoomRun["status"]>(["preparing", "queued", "starting"]);

export interface LoomTimelineProps {
  readonly window: LoomWindow;
  readonly rows: ReadonlyArray<LoomRow>;
  readonly activity: ReadonlyMap<string, LoomLaneActivity>;
  /** Visible lane for every loaded thread, including those hidden under a collapsed row. */
  readonly visibleRowOf: ReadonlyMap<string, number>;
  readonly view: LoomView;
  readonly bounds: LoomView;
  readonly selection: LoomSelection | null;
  readonly onViewChange: (view: LoomView) => void;
  readonly onSelect: (selection: LoomSelection) => void;
  readonly onToggleCollapse: (threadId: string) => void;
}

function useElementWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to this element's size through a ResizeObserver
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    setWidth(element.getBoundingClientRect().width);
    return observeResize(element, (entries) => {
      const entry = entries.at(-1);
      if (entry) setWidth(entry.contentRect.width);
    });
  }, []);
  return { ref, width };
}

export function LoomTimeline(props: LoomTimelineProps) {
  const { ref: sizeRef, width: totalWidth } = useElementWidth();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 0 });
  const labelWidth = Math.min(MAX_LABEL_WIDTH, Math.round(totalWidth * 0.4));
  const timelineWidth = Math.max(totalWidth - labelWidth, 0);
  const scale = loomScale(props.view, timelineWidth);
  const asOfMs = Date.parse(props.window.asOf);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the scroller's height through a ResizeObserver to window visible rows
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const update = () => setScroll({ top: element.scrollTop, height: element.clientHeight });
    update();
    return observeResize(element, update);
  }, []);

  const {
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
  } = useLoomViewGestures({
    wheelRef: scrollRef,
    view: props.view,
    bounds: props.bounds,
    width: timelineWidth,
    leftInset: labelWidth,
    onViewChange: props.onViewChange,
  });

  const firstRow = Math.max(0, Math.floor(scroll.top / LOOM_ROW_HEIGHT) - OVERSCAN_ROWS);
  const lastRow = Math.min(
    props.rows.length,
    Math.ceil((scroll.top + scroll.height) / LOOM_ROW_HEIGHT) + OVERSCAN_ROWS,
  );
  const visibleRows = props.rows.slice(firstRow, lastRow);
  const contentHeight = props.rows.length * LOOM_ROW_HEIGHT;
  const inView = (fromMs: number, toMs: number) =>
    toMs >= props.view.fromMs && fromMs <= props.view.toMs;
  const isSelected = (kind: LoomSelection["kind"], id: string) =>
    props.selection?.kind === kind && props.selection.id === id;

  const ticks = timelineWidth > 0 ? loomTicks(props.view, timelineWidth) : [];
  const rowCenter = (index: number) => index * LOOM_ROW_HEIGHT + LOOM_ROW_HEIGHT / 2;
  const edgePaths = props.window.edges.flatMap((edge) => {
    const source = props.visibleRowOf.get(edge.sourceThreadId);
    const target = props.visibleRowOf.get(edge.targetThreadId);
    const atMs = Date.parse(edge.at);
    if (source === undefined || target === undefined || source === target) return [];
    if (!inView(atMs, atMs)) return [];
    return [{ edge, x: scale.x(atMs), y1: rowCenter(source), y2: rowCenter(target) }];
  });

  return (
    <div ref={sizeRef} className="relative flex min-h-0 flex-1 flex-col">
      <div
        className="flex shrink-0 border-b border-border/70 text-2xs text-muted-foreground"
        style={{ height: AXIS_HEIGHT }}
      >
        <div className="shrink-0 px-3 leading-6" style={{ width: labelWidth }}>
          {props.rows.length} {props.rows.length === 1 ? "lane" : "lanes"}
        </div>
        <svg width={timelineWidth} height={AXIS_HEIGHT} aria-hidden className="shrink-0">
          {ticks.map((tick) => (
            <text key={tick} x={scale.x(tick) + 3} y={16} className="fill-muted-foreground">
              {formatLoomTick(tick, props.view)}
            </text>
          ))}
        </svg>
      </div>
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        onScroll={(event) =>
          setScroll({
            top: event.currentTarget.scrollTop,
            height: event.currentTarget.clientHeight,
          })
        }
      >
        <div className="relative" style={{ height: contentHeight }}>
          <svg
            aria-hidden
            className="pointer-events-none absolute top-0"
            style={{ left: labelWidth }}
            width={timelineWidth}
            height={contentHeight}
          >
            {ticks.map((tick) => (
              <line
                key={tick}
                x1={scale.x(tick)}
                x2={scale.x(tick)}
                y1={0}
                y2={contentHeight}
                className="stroke-border/50"
              />
            ))}
          </svg>
          {visibleRows.map((row, offset) => {
            const index = firstRow + offset;
            return (
              <LoomLaneRow
                key={row.threadId}
                row={row}
                top={index * LOOM_ROW_HEIGHT}
                labelWidth={labelWidth}
                timelineWidth={timelineWidth}
                activity={props.activity.get(row.threadId)}
                sameLaneEdges={props.window.edges.filter(
                  (edge) =>
                    edge.sourceThreadId === row.threadId && edge.targetThreadId === row.threadId,
                )}
                scale={scale}
                asOfMs={asOfMs}
                inView={inView}
                isSelected={isSelected}
                onSelect={props.onSelect}
                onToggleCollapse={props.onToggleCollapse}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
              />
            );
          })}
          <svg
            className="pointer-events-none absolute top-0"
            style={{ left: labelWidth }}
            width={timelineWidth}
            height={contentHeight}
          >
            {edgePaths.map(({ edge, x, y1, y2 }) => {
              const bend = Math.min(48, Math.abs(y2 - y1) / 2);
              return (
                <path
                  key={edge.id}
                  d={`M ${x} ${y1} C ${x + bend} ${y1}, ${x + bend} ${y2}, ${x} ${y2}`}
                  fill="none"
                  strokeWidth={isSelected("edge", edge.id) ? 2 : 1.5}
                  className={cn(
                    "pointer-events-auto cursor-pointer",
                    edge.type === "fork" ? "stroke-info/70" : "stroke-primary/60",
                    isSelected("edge", edge.id) && "stroke-foreground",
                  )}
                  role="button"
                  aria-label={`${loomEdgeLabel(edge)} at ${formatLoomTime(edge.at)}`}
                  onClick={() => props.onSelect({ kind: "edge", id: edge.id })}
                >
                  <title>{`${loomEdgeLabel(edge)} · ${formatLoomTime(edge.at)}`}</title>
                </path>
              );
            })}
          </svg>
        </div>
      </div>
    </div>
  );
}

const RELATIONSHIP_ICON = { fork: GitForkIcon, subagent: BotIcon } as const;

function LoomLaneRow(props: {
  readonly row: LoomRow;
  readonly top: number;
  readonly labelWidth: number;
  readonly timelineWidth: number;
  readonly activity: LoomLaneActivity | undefined;
  readonly sameLaneEdges: ReadonlyArray<LoomEdge>;
  readonly scale: ReturnType<typeof loomScale>;
  readonly asOfMs: number;
  readonly inView: (fromMs: number, toMs: number) => boolean;
  readonly isSelected: (kind: LoomSelection["kind"], id: string) => boolean;
  readonly onSelect: (selection: LoomSelection) => void;
  readonly onToggleCollapse: (threadId: string) => void;
  readonly onPointerDown: (event: PointerEvent<SVGSVGElement>) => void;
  readonly onPointerMove: (event: PointerEvent<SVGSVGElement>) => void;
  readonly onPointerUp: () => void;
}) {
  const { row, scale } = props;
  const RelationshipIcon = row.relationship === "root" ? null : RELATIONSHIP_ICON[row.relationship];
  const laneSelected = props.isSelected("lane", row.threadId);
  const mid = LOOM_ROW_HEIGHT / 2;
  return (
    <div
      className={cn(
        "absolute inset-x-0 flex items-center border-b border-border/30",
        laneSelected && "bg-accent/50",
      )}
      style={{ top: props.top, height: LOOM_ROW_HEIGHT }}
      data-testid="loom-lane"
      data-thread-id={row.threadId}
    >
      <div
        className="flex h-full shrink-0 items-center gap-1 pe-2 text-xs"
        style={{ width: props.labelWidth, paddingInlineStart: 8 + row.depth * 14 }}
      >
        {row.childCount > 0 ? (
          <button
            type="button"
            className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={`${row.collapsed ? "Expand" : "Collapse"} ${row.title}`}
            aria-expanded={!row.collapsed}
            onClick={() => props.onToggleCollapse(row.threadId)}
          >
            {row.collapsed ? (
              <ChevronRightIcon aria-hidden className="size-3" />
            ) : (
              <ChevronDownIcon aria-hidden className="size-3" />
            )}
          </button>
        ) : (
          <span aria-hidden className="size-4 shrink-0" />
        )}
        {RelationshipIcon === null ? null : (
          <RelationshipIcon
            aria-label={row.relationship === "fork" ? "Fork" : "Subagent"}
            className="size-3 shrink-0 text-muted-foreground"
          />
        )}
        {row.parentMissing ? (
          <UnlinkIcon
            aria-label="Parent not loaded"
            className="size-3 shrink-0 text-muted-foreground/70"
          />
        ) : null}
        <button
          type="button"
          className={cn(
            "min-w-0 flex-1 truncate text-start hover:text-foreground",
            row.lane === null ? "text-muted-foreground italic" : "text-foreground/90",
          )}
          onClick={() => props.onSelect({ kind: "lane", id: row.threadId })}
        >
          {row.title}
          {row.lane === null ? <span className="sr-only">, outside this window</span> : null}
        </button>
        {row.hiddenCount > 0 ? (
          <span className="shrink-0 rounded bg-muted px-1 text-3xs text-muted-foreground tabular-nums">
            +{row.hiddenCount}
          </span>
        ) : null}
      </div>
      <svg
        width={props.timelineWidth}
        height={LOOM_ROW_HEIGHT}
        className="shrink-0 cursor-grab active:cursor-grabbing"
        onPointerDown={props.onPointerDown}
        onPointerMove={props.onPointerMove}
        onPointerUp={props.onPointerUp}
        onPointerCancel={props.onPointerUp}
      >
        {(props.activity?.runs ?? []).map((run) => (
          <LoomRunGlyph
            key={run.id}
            run={run}
            scale={scale}
            asOfMs={props.asOfMs}
            mid={mid}
            inView={props.inView}
            selected={props.isSelected("run", run.id)}
            onSelect={props.onSelect}
          />
        ))}
        {props.sameLaneEdges.map((edge) => {
          const atMs = Date.parse(edge.at);
          if (!props.inView(atMs, atMs)) return null;
          const x = scale.x(atMs);
          return (
            <path
              key={edge.id}
              d={`M ${x - 4} ${mid - 6} L ${x} ${mid - 2} L ${x + 4} ${mid - 6}`}
              fill="none"
              strokeWidth={1.5}
              className={cn(
                "cursor-pointer stroke-primary",
                props.isSelected("edge", edge.id) && "stroke-foreground",
              )}
              role="button"
              aria-label={`${loomEdgeLabel(edge)} at ${formatLoomTime(edge.at)}`}
              onClick={() => props.onSelect({ kind: "edge", id: edge.id })}
            >
              <title>{`${loomEdgeLabel(edge)} · ${formatLoomTime(edge.at)}`}</title>
            </path>
          );
        })}
        {(props.activity?.markers ?? []).map((marker) => {
          const atMs = Date.parse(marker.at);
          if (!props.inView(atMs, atMs)) return null;
          const key = loomMarkerKey(marker);
          return (
            <LoomMarkerGlyph
              key={key}
              marker={marker}
              x={scale.x(atMs)}
              y={mid}
              selected={props.isSelected("marker", key)}
              onSelect={() => props.onSelect({ kind: "marker", id: key })}
            />
          );
        })}
      </svg>
    </div>
  );
}

function LoomRunGlyph(props: {
  readonly run: LoomRun;
  readonly scale: ReturnType<typeof loomScale>;
  readonly asOfMs: number;
  readonly mid: number;
  readonly inView: (fromMs: number, toMs: number) => boolean;
  readonly selected: boolean;
  readonly onSelect: (selection: LoomSelection) => void;
}) {
  const { run, scale, mid } = props;
  const requestedMs = Date.parse(run.requestedAt);
  const startedMs = run.startedAt === null ? null : Date.parse(run.startedAt);
  const active = ACTIVE_RUN.has(run.status);
  // An active run is drawn to the as-of time; a finished run with no recorded end gets no span.
  const endMs =
    run.completedAt !== null ? Date.parse(run.completedAt) : active ? props.asOfMs : null;
  // Without a recorded start, only a pre-execution status proves the whole span was queue time.
  const queueEndMs = startedMs ?? (PRE_EXECUTION_RUN.has(run.status) ? endMs : null);
  if (!props.inView(requestedMs, endMs ?? requestedMs)) return null;
  const label = `Run ${run.ordinal}, ${run.status}, requested ${formatLoomTime(run.requestedAt)}${run.startedAt === null ? ", start unknown" : `, started ${formatLoomTime(run.startedAt)}`}${run.completedAt === null ? "" : `, completed ${formatLoomTime(run.completedAt)}`}`;
  const select = () => props.onSelect({ kind: "run", id: run.id });
  const xRequested = scale.x(requestedMs);
  return (
    <g role="button" aria-label={label} className="cursor-pointer" onClick={select}>
      <title>{label}</title>
      {queueEndMs !== null && queueEndMs > requestedMs ? (
        <line
          x1={xRequested}
          x2={scale.x(queueEndMs)}
          y1={mid}
          y2={mid}
          strokeDasharray="2 2"
          className="stroke-muted-foreground/60"
        />
      ) : null}
      {startedMs === null && queueEndMs === null && endMs !== null && endMs > requestedMs ? (
        <line
          data-timing="unknown"
          x1={xRequested}
          x2={scale.x(endMs)}
          y1={mid}
          y2={mid}
          className="stroke-muted-foreground/25"
        />
      ) : null}
      {startedMs !== null && endMs !== null ? (
        <rect
          x={scale.x(startedMs)}
          y={mid - 5}
          width={Math.max(scale.x(endMs) - scale.x(startedMs), 2)}
          height={10}
          rx={3}
          strokeWidth={props.selected ? 1.5 : 0}
          className={cn(RUN_STATUS_CLASS[run.status], props.selected && "stroke-foreground")}
        />
      ) : null}
      <circle
        cx={xRequested}
        cy={mid}
        r={3}
        strokeWidth={1.5}
        className={cn(
          "fill-background stroke-muted-foreground",
          props.selected && "stroke-foreground",
        )}
      />
    </g>
  );
}

function LoomMarkerGlyph(props: {
  readonly marker: LoomMarker;
  readonly x: number;
  readonly y: number;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { marker, x, y } = props;
  const label = `${loomMarkerLabel(marker)}, ${formatLoomTime(marker.at)}`;
  const ring = props.selected ? "stroke-foreground" : "stroke-background";
  const ringWidth = props.selected ? 1.5 : 1;
  const shape = (() => {
    switch (marker.kind) {
      case "checkpoint":
        return (
          <path
            d={`M ${x} ${y - MARK_SIZE - 1} L ${x + MARK_SIZE + 1} ${y} L ${x} ${y + MARK_SIZE + 1} L ${x - MARK_SIZE - 1} ${y} Z`}
            className={marker.fileCount === 0 ? "fill-muted-foreground/40" : "fill-success"}
          />
        );
      case "pull_request":
        return (
          <rect
            x={x - MARK_SIZE}
            y={y - MARK_SIZE}
            width={MARK_SIZE * 2}
            height={MARK_SIZE * 2}
            rx={1.5}
            className="fill-info"
          />
        );
      case "test_command":
        return (
          <path
            d={`M ${x} ${y - MARK_SIZE - 1} L ${x + MARK_SIZE + 1} ${y + MARK_SIZE} L ${x - MARK_SIZE - 1} ${y + MARK_SIZE} Z`}
            className={
              marker.exitCode !== null && marker.exitCode !== 0
                ? "fill-destructive"
                : "fill-warning"
            }
          />
        );
      case "subagent_task":
        return (
          <circle
            cx={x}
            cy={y}
            r={MARK_SIZE}
            strokeWidth={1.5}
            className={cn(
              "fill-background",
              props.selected ? "stroke-foreground" : "stroke-primary",
            )}
          />
        );
    }
  })();
  return (
    <g
      role="button"
      aria-label={label}
      strokeWidth={ringWidth}
      className={cn("cursor-pointer", ring)}
      onClick={props.onSelect}
    >
      <title>{label}</title>
      {shape}
    </g>
  );
}
