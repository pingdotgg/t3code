import type { LoomWindow } from "@t3tools/contracts";
import { useLayoutEffect, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import {
  branchLayout,
  branchSegments,
  branchView,
  workstreamNodes,
  type BranchLayout,
  type BranchNode,
  type BranchStrandPath,
} from "./loomBranch";
import { WEAVE_KINDS, workstreamColor, type WeaveEventKind } from "./loomKinds";
import {
  formatLoomClock,
  formatLoomTick,
  formatLoomTime,
  loomScale,
  loomTicks,
  type LoomView,
} from "./loomScale";
import type { LoomSelection } from "./loomSearch";
import {
  cullGlyphs,
  dotPaths,
  glyphCandidates,
  GLYPH_RADIUS,
  spindleGeometry,
  spindleLayout,
  spindleY,
  strandDots,
  strandPath,
  type Glyph,
  type SpindleGeometry,
  type SpindleLayout,
} from "./loomSpindle";
import {
  loomSelectionThread,
  strandColors,
  type StrandEnd,
  type Weave,
  type WeaveStrand,
  type Workstream,
} from "./loomWeave";
import { useLoomViewGestures } from "./useLoomViewGestures";

const AXIS_HEIGHT = 24;
const INFERRED_DASH = "5 4";

export interface LoomWeaveFieldProps {
  readonly window: LoomWindow;
  readonly weave: Weave;
  readonly mode: "workstream" | "agent";
  readonly spine: Workstream | null;
  readonly view: LoomView;
  readonly bounds: LoomView;
  readonly selection: LoomSelection | null;
  readonly onViewChange: (view: LoomView) => void;
  readonly onSelect: (selection: LoomSelection) => void;
  readonly onOpenWorkstream: (rootId: string) => void;
}

function useElementSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to this element's size through a ResizeObserver
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const rect = element.getBoundingClientRect();
    setSize({ width: rect.width, height: rect.height });
    return observeResize(element, (entries) => {
      const entry = entries.at(-1);
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
  }, []);
  return { ref, ...size };
}

/** The weave: the workstream spindle, or one workstream's branching execution. */
export function LoomWeaveField(props: LoomWeaveFieldProps) {
  const { ref, width, height } = useElementSize();
  const scale = loomScale(props.view, width);
  const gestures = useLoomViewGestures({
    wheelRef: ref,
    view: props.view,
    bounds: props.bounds,
    width,
    leftInset: 0,
    onViewChange: props.onViewChange,
  });
  const asOfMs = props.weave.asOfMs;
  const ticks = width > 0 ? loomTicks(props.view, width) : [];
  const selectedThread = loomSelectionThread(props.window, props.selection);
  const layer = {
    ...props,
    width,
    height,
    scale,
    selectedThread,
    svgProps: {
      onPointerDown: gestures.onPointerDown,
      onPointerMove: gestures.onPointerMove,
      onPointerUp: gestures.onPointerUp,
      onPointerCancel: gestures.onPointerUp,
      className: "cursor-grab active:cursor-grabbing",
    },
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <svg
        width="100%"
        height={AXIS_HEIGHT}
        aria-hidden
        className="shrink-0 border-b border-border/70 text-2xs"
      >
        {ticks.map((tick) => (
          <text key={tick} x={scale.x(tick) + 3} y={16} className="fill-muted-foreground">
            {formatLoomTick(tick, props.view)}
          </text>
        ))}
        {asOfMs >= props.view.fromMs && asOfMs <= props.view.toMs ? (
          <text
            x={scale.x(asOfMs) - 3}
            y={16}
            textAnchor="end"
            className="fill-foreground font-medium"
          >
            Now
          </text>
        ) : null}
      </svg>
      <div
        ref={ref}
        data-testid="loom-weave"
        data-mode={props.mode}
        className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-card"
      >
        {width === 0 ? null : props.mode === "workstream" ? (
          <SpindleLayer {...layer} />
        ) : props.spine === null ? null : (
          <BranchLayer key={props.spine.rootId} {...layer} spine={props.spine} scrollRef={ref} />
        )}
      </div>
    </div>
  );
}

interface LayerProps extends LoomWeaveFieldProps {
  readonly width: number;
  readonly height: number;
  readonly scale: ReturnType<typeof loomScale>;
  readonly selectedThread: string | null;
  readonly svgProps: Record<string, unknown>;
}

/** Anchors and labels keep this far from the field's edges so they are never half drawn. */
const EDGE = 10;

function SpindleLayer(props: LayerProps) {
  const { weave, spine, scale, width, height } = props;
  const layout = spindleLayout(weave, spine, height);
  const geometry = spindleGeometry(width, height, scale.x(weave.startMs), scale.x(weave.tailMs));
  const colors = strandColors(weave, spine);
  const drawn = spindlePaths(weave, layout, geometry, colors, scale.x, width);
  const tailInView = geometry.tailX <= width;
  const tailX = Math.min(geometry.tailX, width - EDGE);
  const startInView = geometry.startX >= 0;
  const startX = Math.max(geometry.startX, EDGE);
  const strandCount = layout.homeY.size;
  // Labels live left of the start anchor; once the view pans that gutter away they sit over the
  // strands on a backdrop.
  const labelWidth = Math.min(256, Math.max(200, startX - 36));
  const bandLabel = (workstream: Workstream, top: number, onSpine: boolean) => (
    <button
      key={workstream.rootId}
      type="button"
      className="absolute start-3 flex flex-col rounded bg-card/80 px-1.5 py-0.5 text-start hover:bg-accent"
      style={{ top, maxWidth: labelWidth }}
      onClick={() => props.onOpenWorkstream(workstream.rootId)}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-full", workstreamColor(workstream.colorIndex).bg)}
        />
        <span
          className={cn("truncate", onSpine ? "font-medium text-foreground" : "text-foreground/90")}
        >
          {workstream.title}
        </span>
      </span>
      <span className="truncate ps-3.5 text-2xs text-muted-foreground">
        {workstream.agentCount} {workstream.agentCount === 1 ? "agent" : "agents"} ·{" "}
        {workstream.runCount} {workstream.runCount === 1 ? "run" : "runs"}
        {workstream.failureCount > 0 ? (
          <span className="text-destructive"> · {workstream.failureCount} failed</span>
        ) : null}
      </span>
    </button>
  );

  return (
    <>
      <svg width={width} height={height} {...props.svgProps}>
        {drawn.warps.map((warp) => (
          <path
            key={warp.threadId}
            d={warp.d}
            fill="none"
            strokeWidth={0.75}
            className={cn(
              "pointer-events-none opacity-40 dark:opacity-30",
              workstreamColor(warp.colorIndex).stroke,
            )}
          />
        ))}
        {drawn.actives.map((active) => {
          const selected = active.threadId === props.selectedThread;
          const onSpine = active.threadId === spine?.rootId;
          const stroke = onSpine ? "stroke-foreground" : workstreamColor(active.colorIndex).stroke;
          return (
            <g key={active.threadId}>
              {onSpine || selected ? <Halo d={active.d} stroke={stroke} /> : null}
              <path
                d={active.d}
                fill="none"
                role="button"
                aria-label={`${active.title}, workstream ${active.workstreamTitle}`}
                strokeWidth={onSpine ? 2.25 : selected ? 2 : 1.5}
                strokeLinecap="round"
                className={cn(
                  "cursor-pointer transition-opacity",
                  stroke,
                  onSpine || selected ? "" : "opacity-85",
                )}
                onClick={() => props.onOpenWorkstream(active.rootId)}
              >
                <title>{active.title}</title>
              </path>
            </g>
          );
        })}
        {drawn.births.map((birth) => (
          <circle
            key={birth.threadId}
            cx={birth.x}
            cy={birth.y}
            r={2.25}
            className={cn("pointer-events-none", workstreamColor(birth.colorIndex).fill)}
          />
        ))}
        {[...drawn.dots].map(([kind, d]) => (
          <path key={kind} d={d} className={cn("pointer-events-none", WEAVE_KINDS[kind].fill)} />
        ))}
        {drawn.glyphs.map((glyph) => (
          <GlyphNode
            key={glyph.key}
            x={glyph.x}
            y={glyph.y}
            kind={glyph.kind}
            failed={glyph.failed}
            inferred={false}
            radius={GLYPH_RADIUS}
            label={glyphLabel(glyph.kind, glyph.ms, glyph.detail)}
            selected={isSelected(props.selection, glyph.selection)}
            onClick={() => props.onSelect(glyph.selection)}
          />
        ))}
        <g className="pointer-events-none">
          {startInView ? (
            <>
              <Anchor x={startX} y={geometry.cy} />
              <text
                x={Math.max(startX + 6, 84)}
                y={geometry.cy - 30}
                textAnchor="end"
                className="fill-foreground/80 text-2xs font-medium uppercase tracking-wide"
              >
                {strandCount} {strandCount === 1 ? "strand" : "strands"}
              </text>
              <text
                x={Math.max(startX + 6, 84)}
                y={geometry.cy - 16}
                textAnchor="end"
                className="fill-muted-foreground text-2xs tabular-nums"
              >
                {formatLoomClock(weave.startMs)}
              </text>
            </>
          ) : null}
          {tailInView ? (
            <>
              <Anchor x={tailX} y={geometry.cy} />
              <text
                x={tailX + 4}
                y={geometry.cy - 30}
                textAnchor="end"
                className="fill-foreground/80 text-2xs font-medium uppercase tracking-wide"
              >
                Loaded tail
              </text>
              <text
                x={tailX + 4}
                y={geometry.cy - 16}
                textAnchor="end"
                className="fill-muted-foreground text-2xs tabular-nums"
              >
                {formatLoomClock(weave.tailMs)}
              </text>
            </>
          ) : null}
        </g>
      </svg>
      {spine === null ? null : bandLabel(spine, layout.cy + 12, true)}
      {layout.bands.map((band) => bandLabel(band.workstream, band.y - 18, false))}
    </>
  );
}

function spindlePaths(
  weave: Weave,
  layout: SpindleLayout,
  geometry: SpindleGeometry,
  colors: ReadonlyMap<string, number>,
  x: (ms: number) => number,
  width: number,
) {
  const warps: Array<{ threadId: string; colorIndex: number; d: string }> = [];
  const actives: Array<{
    threadId: string;
    rootId: string;
    title: string;
    workstreamTitle: string;
    colorIndex: number;
    d: string;
  }> = [];
  const births: Array<{ threadId: string; colorIndex: number; x: number; y: number }> = [];
  const dots: Array<ReturnType<typeof strandDots>[number]> = [];
  const candidates: Glyph[] = [];
  const startX = Math.max(geometry.startX, 0);
  const tailX = Math.min(geometry.tailX, width);
  for (const workstream of weave.workstreams) {
    for (const strand of workstream.strands) {
      const homeY = layout.homeY.get(strand.threadId);
      const colorIndex = colors.get(strand.threadId) ?? workstream.colorIndex;
      if (homeY === undefined) {
        // A quiet child has no strand; its spawn marks its parent's.
        const parentY =
          strand.parentThreadId === null ? undefined : layout.homeY.get(strand.parentThreadId);
        const at = strand.spawn === null ? null : x(strand.spawn.ms);
        if (parentY !== undefined && at !== null && at >= startX && at <= tailX) {
          births.push({
            threadId: strand.threadId,
            colorIndex,
            x: at,
            y: spindleY(geometry, parentY, at),
          });
        }
        continue;
      }
      const y = (px: number) => spindleY(geometry, homeY, px);
      warps.push({
        threadId: strand.threadId,
        colorIndex,
        d: strandPath(geometry, homeY, startX, tailX),
      });
      if (strand.extent === null) continue;
      const fromX = Math.max(x(strand.extent.startMs), startX);
      const toX = Math.min(x(strand.extent.endMs), tailX);
      const d = strandPath(geometry, homeY, fromX, toX);
      if (d.length > 0) {
        actives.push({
          threadId: strand.threadId,
          rootId: workstream.rootId,
          title: strand.title,
          workstreamTitle: workstream.title,
          colorIndex,
          d,
        });
      } else if (toX > fromX - 1 && fromX <= tailX) {
        births.push({ threadId: strand.threadId, colorIndex, x: fromX, y: y(fromX) });
      }
      dots.push(...strandDots(strand.events, x, y, width));
      candidates.push(...glyphCandidates(strand, x, y, width));
    }
  }
  return { warps, actives, births, dots: dotPaths(dots), glyphs: cullGlyphs(candidates) };
}

/** A static glow: the same line drawn wide and faint underneath. */
function Halo(props: { readonly d: string; readonly stroke: string }) {
  return (
    <path
      d={props.d}
      fill="none"
      strokeWidth={7}
      strokeLinecap="round"
      className={cn("pointer-events-none opacity-20", props.stroke)}
    />
  );
}

function Anchor(props: { readonly x: number; readonly y: number }) {
  return (
    <g>
      <circle cx={props.x} cy={props.y} r={10} className="fill-foreground/10" />
      <circle
        cx={props.x}
        cy={props.y}
        r={6}
        strokeWidth={1.5}
        className="fill-card stroke-foreground"
      />
      <circle cx={props.x} cy={props.y} r={2} className="fill-foreground" />
    </g>
  );
}

const NODE_RADIUS = 9;
const LANE_LABEL_WIDTH = 220;
const END_STYLE: Record<StrandEnd, string> = {
  completed: "fill-current stroke-current",
  failed: "fill-destructive stroke-destructive",
  interrupted: "fill-card stroke-muted-foreground",
  active: "fill-card stroke-current",
  unknown: "fill-card stroke-current",
};

function BranchLayer(
  props: LayerProps & {
    readonly spine: Workstream;
    readonly scrollRef: React.RefObject<HTMLDivElement | null>;
  },
) {
  const { spine, scale, width, height } = props;
  // Lanes pack at the zoom Agent mode opens with, so they stay put while the view zooms.
  const layout = branchLayout(
    spine,
    loomScale(branchView(spine, props.bounds, props.weave.tailMs), width).msPerPx,
  );
  const offsetY = Math.max(0, (height - layout.height) / 2);
  const svgHeight = Math.max(height, layout.height);
  const nodes = workstreamNodes(spine, layout, scale.x, width);
  const colors = strandColors(props.weave, spine);
  const paths = spine.strands.flatMap((strand) => {
    const path = branchSegments(strand, layout, scale.x);
    return path === null ? [] : [{ strand, path }];
  });
  const labelRoom = laneLabelRoom(paths, layout, width);
  const rootY = layout.cy;
  const { scrollRef } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sets the DOM scroll position so a tall workstream opens on its root, not its topmost branch
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element !== null) element.scrollTop = Math.max(0, rootY - element.clientHeight / 2);
  }, [scrollRef, rootY]);

  return (
    <>
      <svg width={width} height={svgHeight} {...props.svgProps}>
        <g transform={`translate(0 ${offsetY})`}>
          {paths.map(({ strand, path }) => (
            <BranchStrand
              key={strand.threadId}
              strand={strand}
              path={path}
              layout={layout}
              color={workstreamColor(colors.get(strand.threadId) ?? spine.colorIndex)}
              root={strand.threadId === spine.rootId}
              selected={strand.threadId === props.selectedThread}
              onSelect={() => props.onSelect({ kind: "lane", id: strand.threadId })}
            />
          ))}
          {[...nodes.values()].flatMap((list) =>
            list.map((node) => (
              <BranchEventNode
                key={node.key}
                node={node}
                selected={isSelected(props.selection, node.selection)}
                onSelect={() => props.onSelect(node.selection)}
              />
            )),
          )}
        </g>
      </svg>
      {paths.map(({ strand, path }) => {
        const y = layout.laneY.get(strand.threadId);
        const room = labelRoom.get(strand.threadId);
        if (y === undefined || room === undefined) return null;
        const left = Math.max(path.laneX, EDGE);
        const color = workstreamColor(colors.get(strand.threadId) ?? spine.colorIndex);
        return (
          <button
            key={strand.threadId}
            type="button"
            className={cn(
              "absolute flex items-center gap-1.5 rounded bg-card/80 px-1 py-0.5 text-xs hover:bg-accent",
              strand.threadId === props.selectedThread
                ? "bg-accent text-foreground"
                : "text-foreground/85",
            )}
            style={{ left, top: offsetY + y - NODE_RADIUS - 32, maxWidth: room }}
            onClick={() => props.onSelect({ kind: "lane", id: strand.threadId })}
          >
            <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", color.bg)} />
            <span className="truncate">{strand.title}</span>
          </button>
        );
      })}
    </>
  );
}

/**
 * How wide each strand's title may be: up to the next strand that starts on the same lane, or the
 * field's edge. Titles with too little room are left off; the strand still names itself on hover.
 */
function laneLabelRoom(
  paths: ReadonlyArray<{ readonly strand: WeaveStrand; readonly path: BranchStrandPath }>,
  layout: BranchLayout,
  width: number,
): ReadonlyMap<string, number> {
  const byLane = new Map<number, Array<{ threadId: string; left: number; endX: number }>>();
  for (const { strand, path } of paths) {
    const y = layout.laneY.get(strand.threadId)!;
    const lane = byLane.get(y) ?? [];
    lane.push({ threadId: strand.threadId, left: Math.max(path.laneX, EDGE), endX: path.endX });
    byLane.set(y, lane);
  }
  const room = new Map<string, number>();
  for (const lane of byLane.values()) {
    lane.sort((a, b) => a.left - b.left);
    lane.forEach((entry, index) => {
      if (entry.endX < 0) return;
      const limit = Math.min(lane[index + 1]?.left ?? width, width) - 8;
      const available = Math.min(LANE_LABEL_WIDTH, limit - entry.left);
      if (available >= 48) room.set(entry.threadId, available);
    });
  }
  return room;
}

function BranchStrand(props: {
  readonly strand: WeaveStrand;
  readonly path: BranchStrandPath;
  readonly layout: BranchLayout;
  readonly color: ReturnType<typeof workstreamColor>;
  readonly root: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { strand, path, layout } = props;
  const y = layout.laneY.get(strand.threadId)!;
  const parentY =
    strand.parentThreadId === null ? null : (layout.laneY.get(strand.parentThreadId) ?? null);
  const segments = path.segments;
  return (
    <g className={props.root ? "text-foreground" : props.color.text}>
      {props.root || props.selected
        ? segments.map((segment) => (
            <Halo key={`halo:${segment.d}`} d={segment.d} stroke="stroke-current" />
          ))
        : null}
      {segments.map((segment, index) => (
        <path
          key={segment.d}
          d={segment.d}
          fill="none"
          role={index === segments.length - 1 ? "button" : undefined}
          aria-label={index === segments.length - 1 ? strand.title : undefined}
          strokeWidth={props.root ? 2.5 : props.selected ? 2.25 : 1.75}
          strokeLinecap="round"
          strokeDasharray={segment.inferred ? INFERRED_DASH : undefined}
          className="cursor-pointer stroke-current"
          onClick={props.onSelect}
        />
      ))}
      {strand.rejoin !== null && parentY !== null ? null : strand.end === "failed" ? (
        <Octagon x={path.endX} y={y} radius={NODE_RADIUS - 3} />
      ) : (
        <circle
          cx={path.endX}
          cy={y}
          r={strand.end === "active" ? 5 : 3.5}
          strokeWidth={1.5}
          className={cn("pointer-events-none", END_STYLE[strand.end])}
        >
          <title>{END_LABEL[strand.end]}</title>
        </circle>
      )}
    </g>
  );
}

const END_LABEL: Record<StrandEnd, string> = {
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  active: "Still running",
  unknown: "No run recorded",
};

function BranchEventNode(props: {
  readonly node: BranchNode;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { node } = props;
  const detail = node.detail ?? (node.count > 1 ? `${node.count} events` : null);
  return (
    <>
      <GlyphNode
        x={node.x}
        y={node.y}
        kind={node.kind}
        failed={node.failed}
        inferred={false}
        radius={NODE_RADIUS}
        count={node.count}
        ring={node.kind === "rejoin"}
        label={glyphLabel(node.kind, node.ms, detail)}
        selected={props.selected}
        onClick={props.onSelect}
      />
      {node.labelled ? (
        <g
          transform={`translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`}
          className="pointer-events-none stroke-card [paint-order:stroke]"
          strokeWidth={3}
          strokeLinejoin="round"
          textAnchor="middle"
        >
          <text y={NODE_RADIUS + 12} className="fill-muted-foreground text-3xs uppercase">
            {WEAVE_KINDS[node.kind].label}
          </text>
          <text y={NODE_RADIUS + 23} className="fill-foreground/80 text-2xs">
            {formatLoomClock(node.ms)}
          </text>
          {detail === null ? null : (
            <text y={NODE_RADIUS + 34} className="fill-muted-foreground text-2xs">
              {detail.length > 12 ? `${detail.slice(0, 11)}…` : detail}
            </text>
          )}
        </g>
      ) : null}
    </>
  );
}

function glyphLabel(kind: WeaveEventKind, ms: number, detail: string | null) {
  return `${WEAVE_KINDS[kind].label}, ${formatLoomTime(new Date(ms).toISOString())}${detail === null ? "" : `, ${detail}`}`;
}

function isSelected(selection: LoomSelection | null, target: LoomSelection) {
  return selection?.kind === target.kind && selection.id === target.id;
}

function GlyphNode(props: {
  readonly x: number;
  readonly y: number;
  readonly kind: WeaveEventKind;
  readonly failed: boolean;
  readonly inferred: boolean;
  readonly radius: number;
  readonly label: string;
  readonly selected: boolean;
  readonly count?: number;
  readonly ring?: boolean;
  readonly onClick: () => void;
}) {
  const style = WEAVE_KINDS[props.kind];
  const Icon = style.icon;
  const r = props.radius;
  const iconSize = Math.round(r * 1.25);
  return (
    <g
      transform={`translate(${props.x.toFixed(1)} ${props.y.toFixed(1)})`}
      role="button"
      aria-label={props.label}
      className={cn("cursor-pointer", props.failed ? "text-destructive" : style.text)}
      onClick={props.onClick}
    >
      <title>{props.label}</title>
      {props.failed ? (
        <Octagon
          x={0}
          y={0}
          radius={r}
          className={cn("fill-card", props.selected ? "stroke-foreground" : "stroke-destructive")}
        />
      ) : (
        <circle
          r={r}
          strokeWidth={props.selected ? 2 : 1.25}
          strokeDasharray={props.inferred ? "2 2" : undefined}
          className={cn("fill-card", props.selected ? "stroke-foreground" : "stroke-current")}
        />
      )}
      {props.ring ? (
        <circle r={r + 3} fill="none" strokeWidth={1} className="stroke-current" />
      ) : null}
      <Icon
        aria-hidden
        x={-iconSize / 2}
        y={-iconSize / 2}
        width={iconSize}
        height={iconSize}
        strokeWidth={2}
      />
      {props.count !== undefined && props.count > 1 ? (
        <CountBadge r={r} count={props.count} />
      ) : null}
    </g>
  );
}

/** Sits off the node's upper right, clear of its circle, so the icon stays readable. */
function CountBadge(props: { readonly r: number; readonly count: number }) {
  const text = props.count > 999 ? "999+" : String(props.count);
  const width = 6 + text.length * 5;
  const corner = props.r * Math.SQRT1_2 + 1;
  return (
    <g
      transform={`translate(${corner.toFixed(1)} ${(-corner - 10).toFixed(1)})`}
      className="pointer-events-none"
    >
      <rect
        width={width}
        height={10}
        rx={5}
        className="fill-foreground stroke-card"
        strokeWidth={1.5}
      />
      <text
        x={width / 2}
        y={7.5}
        textAnchor="middle"
        className="fill-background text-4xs font-semibold tabular-nums"
      >
        {text}
      </text>
    </g>
  );
}

function Octagon(props: {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly className?: string;
}) {
  const { x, y, radius: r } = props;
  const k = r * Math.tan(Math.PI / 8);
  const d = `M${x - k} ${y - r}H${x + k}L${x + r} ${y - k}V${y + k}L${x + k} ${y + r}H${x - k}L${x - r} ${y + k}V${y - k}Z`;
  return (
    <path
      d={d}
      strokeWidth={1.5}
      className={props.className ?? "fill-destructive stroke-destructive"}
    />
  );
}
