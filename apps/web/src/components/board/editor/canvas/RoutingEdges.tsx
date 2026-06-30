import { useEffect, useId, useMemo, useState } from "react";

import type { WorkflowDefinitionEncoded } from "@t3tools/contracts";

import type { WorkflowEditorSelection } from "~/workflow/editorModel";

import { cn } from "~/lib/utils";

import type { CanvasLayout } from "./canvasLayout";
import { LANE_CARD_WIDTH } from "./canvasLayout";
import {
  classifyEdge,
  clearBottomForSpan,
  edgeEndpointSides,
  packDetourLanes,
  routeDetour,
  routeEdge,
  type DetourSpan,
  type EdgeRect,
} from "./edgeRouting";
import { routeDndId, ROUTE_KIND_LABEL_FILL_CLASS, ROUTE_KIND_STROKE_CLASS } from "./RoutingHandles";

type RouteKind = "success" | "failure" | "blocked";

// Direction particles travel at a constant speed regardless of edge length, so
// dur scales with the path length; the dot count scales too so spacing stays
// even on long detours without bunching on short hops.
const PARTICLE_SPEED = 70; // px per second
const PARTICLE_MIN = 2;
const PARTICLE_MAX = 6;
const PARTICLE_SPACING = 120; // px between dots (drives the count)

export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

export type CanvasAnchors = Readonly<Record<string, CanvasPoint>>;

interface RoutingEdge {
  readonly id: string;
  readonly testId: string;
  readonly label: string;
  readonly sourceLaneKey: string;
  readonly targetLaneKey: string;
  readonly sourceAnchorId: string;
  readonly targetAnchorId: string;
  readonly edgeKind: "step-on" | "lane-transition" | "lane-on" | "lane-action";
  readonly precedence: 1 | 2 | 3 | 4;
  readonly displayLabel: string;
  readonly routeKind: RouteKind | undefined;
  readonly dashed: boolean;
  readonly selfLoop: boolean;
  readonly selection: WorkflowEditorSelection;
}

const routeKinds = ["success", "failure", "blocked"] as const satisfies readonly RouteKind[];

// Reduced-motion fallback: when the user prefers reduced motion we drop the
// animated direction particles and show a static arrowhead instead. Browsers
// disagree on marker fill="context-stroke", so each edge color gets its own
// marker; currentColor inside a marker resolves against the marker's own class.
const EDGE_ARROW_MARKERS = [
  { id: "workflow-edge-arrow-success", className: "text-success" },
  { id: "workflow-edge-arrow-failure", className: "text-destructive" },
  { id: "workflow-edge-arrow-blocked", className: "text-warning" },
  { id: "workflow-edge-arrow-action", className: "text-info" },
  { id: "workflow-edge-arrow-muted", className: "text-muted-foreground" },
] as const;

const edgeArrowMarkerId = (edge: {
  readonly edgeKind: RoutingEdge["edgeKind"];
  readonly routeKind: RouteKind | undefined;
}): string => {
  if (edge.edgeKind === "lane-action") {
    return "workflow-edge-arrow-action";
  }
  switch (edge.routeKind) {
    case "success":
      return "workflow-edge-arrow-success";
    case "failure":
      return "workflow-edge-arrow-failure";
    case "blocked":
      return "workflow-edge-arrow-blocked";
    default:
      return "workflow-edge-arrow-muted";
  }
};

const edgeColorClass = (edge: {
  readonly edgeKind: RoutingEdge["edgeKind"];
  readonly routeKind: RouteKind | undefined;
}): string => {
  if (edge.edgeKind === "lane-action") {
    return "text-info";
  }
  return edge.routeKind ? ROUTE_KIND_STROKE_CLASS[edge.routeKind] : "text-muted-foreground";
};

const edgeLabelFillClass = (edge: {
  readonly edgeKind: RoutingEdge["edgeKind"];
  readonly routeKind: RouteKind | undefined;
}): string => {
  if (edge.edgeKind === "lane-action") {
    return "fill-info";
  }
  return edge.routeKind ? ROUTE_KIND_LABEL_FILL_CLASS[edge.routeKind] : "fill-muted-foreground";
};

type RoutingEdgeIdParts = readonly [string, ...string[]];

const routingEdgeId = (parts: RoutingEdgeIdParts): string =>
  routeDndId(["workflow-edge", ...parts] as [string, ...string[]]);

export const routingEdgeTestId = (parts: RoutingEdgeIdParts): string =>
  routeDndId(["workflow-edge-testid", ...parts] as [string, ...string[]]);

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function RoutingEdges({
  definition,
  layout,
  anchors,
  selection,
  onSelect,
}: {
  readonly definition: WorkflowDefinitionEncoded;
  readonly layout: CanvasLayout;
  readonly anchors: CanvasAnchors;
  readonly selection?: WorkflowEditorSelection | null | undefined;
  readonly onSelect: (selection: WorkflowEditorSelection) => void;
}) {
  const reactId = useId();
  const reducedMotion = useReducedMotion();
  const canvasHeight = Math.max(layout.height, 1);

  // The route/pack/label pipeline is O(edges^2) (detour packing + label
  // de-collision). It depends only on the board geometry — definition, layout,
  // anchors — never on `selection`, so memoize it: a lane selection/hover (which
  // only changes focus dimming below) must not re-pay it on every render.
  const edges = useMemo(
    () =>
      [...deriveRoutingEdges(definition)].sort((left, right) => right.precedence - left.precedence),
    [definition],
  );
  const routes = useMemo(() => computeEdgeRoutes(edges, layout, anchors), [edges, layout, anchors]);

  // Pills are always shown, so resolve overlaps once: collect each label's box
  // and de-collide it (vertical stagger) so labels never sit on top of each other.
  const labelPositions = useMemo(
    () =>
      layoutLabels(
        edges.flatMap((edge) => {
          const route = routes.get(edge.id);
          if (!route) {
            return [];
          }
          return [
            {
              id: edge.id,
              x: route.labelX,
              y: route.labelY,
              w: estimatePillWidth(edge.displayLabel),
            },
          ];
        }),
      ),
    [edges, routes],
  );

  // With a lane selected, edges that neither leave nor enter it fade out so the
  // selected lane's wiring is traceable. Focused edges render last (on top).
  const focusLaneKey = selection?.laneKey ?? null;
  const isFocused = (edge: RoutingEdge): boolean =>
    focusLaneKey === null ||
    edge.sourceLaneKey === focusLaneKey ||
    edge.targetLaneKey === focusLaneKey;
  // Only the ordering (a stable sort) is selection-dependent, so this is the
  // single cheap step that re-runs on focus change. `isFocused` is fully
  // determined by `focusLaneKey`, so that + `edges` are the real deps.
  const orderedEdges = useMemo(() => {
    const focused = (edge: RoutingEdge): boolean =>
      focusLaneKey === null ||
      edge.sourceLaneKey === focusLaneKey ||
      edge.targetLaneKey === focusLaneKey;
    return [...edges].sort((left, right) => Number(focused(left)) - Number(focused(right)));
  }, [edges, focusLaneKey]);

  return (
    <svg
      className="pointer-events-none absolute inset-0 overflow-visible"
      width={layout.width}
      height={canvasHeight}
      aria-hidden={false}
    >
      <defs>
        {EDGE_ARROW_MARKERS.map((marker) => (
          <marker
            key={marker.id}
            id={marker.id}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
            className={marker.className}
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        ))}
      </defs>
      {orderedEdges.map((edge, index) => {
        const route = routes.get(edge.id);
        if (!route) {
          return null;
        }

        const dimmed = !isFocused(edge);
        const colorClass = edgeColorClass(edge);
        const coreId = `${reactId}-core-${index}`;
        const dash = edge.edgeKind === "lane-action" ? "2 4" : edge.dashed ? "6 4" : undefined;
        const labelPos = labelPositions.get(edge.id) ?? { x: route.labelX, y: route.labelY };
        const particleCount = clamp(
          Math.round(route.length / PARTICLE_SPACING),
          PARTICLE_MIN,
          PARTICLE_MAX,
        );
        const particleDur = Math.max(0.6, route.length / PARTICLE_SPEED);

        return (
          <g
            key={edge.id}
            data-dimmed={dimmed ? "true" : undefined}
            className={cn("transition-opacity duration-150", colorClass, dimmed && "opacity-15")}
          >
            {/* Glow tube: a wide soft halo + a brighter rim + the bright core line,
                all in the edge color. Theme-safe (no blend mode) — reads as a glow
                on dark and an emphasized soft line on light. */}
            <path
              d={route.d}
              fill="none"
              stroke="currentColor"
              strokeWidth={10}
              strokeOpacity={0.1}
              strokeLinecap="round"
              className="pointer-events-none"
            />
            <path
              d={route.d}
              fill="none"
              stroke="currentColor"
              strokeWidth={5}
              strokeOpacity={0.22}
              strokeLinecap="round"
              className="pointer-events-none"
            />
            <path
              id={coreId}
              d={route.d}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={dash}
              markerEnd={reducedMotion ? `url(#${edgeArrowMarkerId(edge)})` : undefined}
              className="pointer-events-none"
            />

            {/* Direction: a stream of comet dots (colored halo + bright core)
                flowing toward the target at constant speed. Falls back to the
                static arrowhead above when the user prefers reduced motion. */}
            {!reducedMotion &&
              Array.from({ length: particleCount }).map((_, dot) => {
                const begin = `-${((dot * particleDur) / particleCount).toFixed(2)}s`;
                return (
                  <g key={dot} className="pointer-events-none">
                    <circle r={4} fill="currentColor" fillOpacity={0.3}>
                      <animateMotion dur={`${particleDur}s`} repeatCount="indefinite" begin={begin}>
                        <mpath href={`#${coreId}`} xlinkHref={`#${coreId}`} />
                      </animateMotion>
                    </circle>
                    <circle r={1.8} fill="currentColor">
                      <animateMotion dur={`${particleDur}s`} repeatCount="indefinite" begin={begin}>
                        <mpath href={`#${coreId}`} xlinkHref={`#${coreId}`} />
                      </animateMotion>
                    </circle>
                  </g>
                );
              })}

            {/* Wide transparent hit target carrying the edge identity + click. */}
            <path
              data-testid={edge.testId}
              data-edge-kind={edge.edgeKind}
              data-precedence={edge.precedence}
              data-self-loop={edge.selfLoop ? "true" : undefined}
              aria-label={edge.label}
              d={route.d}
              fill="none"
              stroke="transparent"
              strokeWidth={14}
              strokeDasharray={dash}
              className="pointer-events-auto cursor-pointer"
              style={{ pointerEvents: "stroke" }}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(edge.selection);
              }}
            />

            {/* On-line pill label (de-collided). The 0.8-opacity background lets
                the line/dots show through so the label reads as sitting on it. */}
            <g className="pointer-events-none">
              <rect
                x={labelPos.x - estimatePillWidth(edge.displayLabel) / 2}
                y={labelPos.y - 8}
                width={estimatePillWidth(edge.displayLabel)}
                height={16}
                rx={5}
                className="fill-background"
                fillOpacity={0.8}
                stroke="currentColor"
                strokeOpacity={0.45}
                strokeWidth={1}
              />
              <text
                x={labelPos.x}
                y={labelPos.y}
                textAnchor="middle"
                dominantBaseline="central"
                className={cn("text-[10px] font-medium", edgeLabelFillClass(edge))}
              >
                {edge.displayLabel}
              </text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function estimatePillWidth(label: string): number {
  return label.length * 6 + 12;
}

function laneRectFromLayout(layout: CanvasLayout, laneKey: string): EdgeRect | null {
  const lane = layout.lanes.find((candidate) => candidate.laneKey === laneKey);
  if (!lane) {
    return null;
  }
  return { x: lane.x, y: lane.y, width: lane.width, height: lane.estimatedHeight };
}

interface EdgeRoute {
  readonly d: string;
  readonly labelX: number;
  readonly labelY: number;
  readonly length: number;
}

// Ports are chosen from lane geometry (which sides actually face each other)
// rather than fixed handle positions. Channel (multi-column / back) edges route
// as local detours through a packed track just below the cards they span, so
// they never cut underneath intermediate cards or swing out to a far corridor.
function computeEdgeRoutes(
  edges: ReadonlyArray<RoutingEdge>,
  layout: CanvasLayout,
  anchors: CanvasAnchors,
): ReadonlyMap<string, EdgeRoute> {
  interface PlannedEdge {
    readonly edge: RoutingEdge;
    readonly source: EdgeRect;
    readonly target: EdgeRect;
    readonly sourceSideKey: string;
    readonly targetSideKey: string;
    readonly isChannel: boolean;
  }

  const planned: PlannedEdge[] = [];
  const routes = new Map<string, EdgeRoute>();
  const cards = layout.lanes.map((lane) => ({
    x: lane.x,
    y: lane.y,
    width: lane.width,
    height: lane.estimatedHeight,
  }));
  const centerX = (rect: EdgeRect): number => rect.x + rect.width / 2;

  for (const edge of edges) {
    if (edge.selfLoop) {
      const source = anchorPoint(
        edge.sourceAnchorId,
        edge.sourceLaneKey,
        layout,
        anchors,
        "source",
      );
      const target = anchorPoint(
        edge.targetAnchorId,
        edge.targetLaneKey,
        layout,
        anchors,
        "target",
      );
      const midpoint = { x: source.x + 52, y: Math.min(source.y, target.y) - 42 };
      const d = selfLoopPath(source, target);
      routes.set(edge.id, {
        d,
        labelX: midpoint.x,
        labelY: midpoint.y,
        length: Math.abs(source.y - midpoint.y) * 2 + 120,
      });
      continue;
    }

    const source = laneRectFromLayout(layout, edge.sourceLaneKey);
    const target = laneRectFromLayout(layout, edge.targetLaneKey);
    if (!source || !target) {
      continue;
    }
    const sides = edgeEndpointSides(source, target);
    planned.push({
      edge,
      source,
      target,
      // Slots are allocated per physical card side counting BOTH source and
      // target endpoints, so opposite-direction edges between the same two
      // cards fan into adjacent ports instead of overlapping.
      sourceSideKey: `${edge.sourceLaneKey}:${sides.source}`,
      targetSideKey: `${edge.targetLaneKey}:${sides.target}`,
      isChannel: classifyEdge(source, target).kind === "channel",
    });
  }

  const sideCounts = new Map<string, number>();
  for (const plan of planned) {
    sideCounts.set(plan.sourceSideKey, (sideCounts.get(plan.sourceSideKey) ?? 0) + 1);
    sideCounts.set(plan.targetSideKey, (sideCounts.get(plan.targetSideKey) ?? 0) + 1);
  }

  const sideSlots = new Map<string, number>();
  const takeSlot = (key: string): number => {
    const slot = sideSlots.get(key) ?? 0;
    sideSlots.set(key, slot + 1);
    return slot;
  };

  // Pack channel edges into horizontal detour tracks. Spans use card centers
  // (ignoring per-edge port fan-out) so this matches the depth canvasLayout
  // reserves for the bottom of the surface.
  const channelPlans = planned.filter((plan) => plan.isChannel);
  const spans: DetourSpan[] = channelPlans.map((plan) => {
    const left = Math.min(centerX(plan.source), centerX(plan.target));
    const right = Math.max(centerX(plan.source), centerX(plan.target));
    return { left, right, clearBottom: clearBottomForSpan(left, right, cards) };
  });
  const { lanes: detourLanes } = packDetourLanes(spans);
  const laneYByEdge = new Map<string, number>();
  channelPlans.forEach((plan, index) => {
    laneYByEdge.set(plan.edge.id, detourLanes[index] ?? 0);
  });

  for (const plan of planned) {
    const portInput = {
      source: plan.source,
      target: plan.target,
      sourceSlot: takeSlot(plan.sourceSideKey),
      sourceCount: sideCounts.get(plan.sourceSideKey) ?? 1,
      targetSlot: takeSlot(plan.targetSideKey),
      targetCount: sideCounts.get(plan.targetSideKey) ?? 1,
    };
    const route = plan.isChannel
      ? routeDetour({ ...portInput, laneY: laneYByEdge.get(plan.edge.id) ?? 0 })
      : routeEdge(portInput);
    routes.set(plan.edge.id, {
      d: route.d,
      labelX: route.labelX,
      labelY: route.labelY,
      length: route.length,
    });
  }

  return routes;
}

export function deriveRoutingEdges(
  definition: WorkflowDefinitionEncoded,
): ReadonlyArray<RoutingEdge> {
  const laneNames = new Map(definition.lanes.map((lane) => [String(lane.key), lane.name]));
  const edges: RoutingEdge[] = [];

  for (const lane of definition.lanes) {
    const laneKey = String(lane.key);
    for (const step of lane.pipeline ?? []) {
      const stepKey = String(step.key);
      for (const kind of routeKinds) {
        const targetLaneKey = step.on?.[kind];
        if (!targetLaneKey || !laneNames.has(String(targetLaneKey))) {
          continue;
        }
        const targetKey = String(targetLaneKey);
        edges.push({
          id: routingEdgeId(["step-on", laneKey, stepKey, kind, targetKey]),
          testId: routingEdgeTestId(["step-on", laneKey, stepKey, kind, targetKey]),
          label: `Step ${stepKey} ${kind} route from ${lane.name} to ${laneNames.get(targetKey)}`,
          sourceLaneKey: laneKey,
          targetLaneKey: targetKey,
          sourceAnchorId: `step-${laneKey}-${stepKey}-on-${kind}`,
          targetAnchorId: `lane-${targetKey}-target`,
          edgeKind: "step-on",
          precedence: 1,
          displayLabel: kind,
          routeKind: kind,
          dashed: false,
          selfLoop: laneKey === targetKey,
          selection: { kind: "step", laneKey, stepKey },
        });
      }
    }

    for (const [index, transition] of (lane.transitions ?? []).entries()) {
      const targetKey = String(transition.to);
      if (!laneNames.has(targetKey)) {
        continue;
      }
      edges.push({
        id: routingEdgeId(["transition", laneKey, String(index), targetKey]),
        testId: routingEdgeTestId(["transition", laneKey, String(index), targetKey]),
        label: `Transition ${index + 1} from ${lane.name} to ${laneNames.get(targetKey)}`,
        sourceLaneKey: laneKey,
        targetLaneKey: targetKey,
        sourceAnchorId: `lane-${laneKey}-on-success`,
        targetAnchorId: `lane-${targetKey}-target`,
        edgeKind: "lane-transition",
        precedence: 2,
        displayLabel: `#${index + 1}`,
        routeKind: undefined,
        dashed: false,
        selfLoop: laneKey === targetKey,
        selection: {
          kind: "transition",
          laneKey,
          index,
        },
      });
    }

    for (const [index, action] of (lane.actions ?? []).entries()) {
      const targetKey = String(action.to);
      if (!laneNames.has(targetKey)) {
        continue;
      }
      edges.push({
        id: routingEdgeId(["lane-action", laneKey, String(index), targetKey]),
        testId: routingEdgeTestId(["lane-action", laneKey, String(index), targetKey]),
        label: `Action "${action.label}" from ${lane.name} to ${laneNames.get(targetKey)}`,
        sourceLaneKey: laneKey,
        targetLaneKey: targetKey,
        sourceAnchorId: `lane-${laneKey}-action-${index}`,
        targetAnchorId: `lane-${targetKey}-target`,
        edgeKind: "lane-action",
        precedence: 4,
        displayLabel: action.label,
        routeKind: undefined,
        dashed: false,
        selfLoop: laneKey === targetKey,
        selection: { kind: "lane", laneKey },
      });
    }

    for (const kind of routeKinds) {
      const targetLaneKey = lane.on?.[kind];
      if (!targetLaneKey || !laneNames.has(String(targetLaneKey))) {
        continue;
      }
      const targetKey = String(targetLaneKey);
      edges.push({
        id: routingEdgeId(["lane-on", laneKey, kind, targetKey]),
        testId: routingEdgeTestId(["lane-on", laneKey, kind, targetKey]),
        label: `Lane ${lane.name} ${kind} fallback route to ${laneNames.get(targetKey)}`,
        sourceLaneKey: laneKey,
        targetLaneKey: targetKey,
        sourceAnchorId: `lane-${laneKey}-on-${kind}`,
        targetAnchorId: `lane-${targetKey}-target`,
        edgeKind: "lane-on",
        precedence: 3,
        displayLabel: kind,
        routeKind: kind,
        dashed: true,
        selfLoop: laneKey === targetKey,
        selection: { kind: "lane", laneKey },
      });
    }
  }

  return edges;
}

/** IDs of edges that route through a local detour (multi-column / back-edge). */
export function channelRoutedEdgeIds(
  edges: ReadonlyArray<RoutingEdge>,
  layout: CanvasLayout,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const edge of edges) {
    if (edge.selfLoop) {
      continue;
    }
    const source = laneRectFromLayout(layout, edge.sourceLaneKey);
    const target = laneRectFromLayout(layout, edge.targetLaneKey);
    if (!source || !target) {
      continue;
    }
    if (classifyEdge(source, target).kind === "channel") {
      ids.add(edge.id);
    }
  }
  return ids;
}

export interface LabelBox {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
}

/**
 * Resolve overlapping label pills: place each (in reading order) and, when it
 * collides with an already-placed pill whose horizontal span overlaps, push it
 * down past it. Vertical displacement keeps each pill near its (mostly vertical)
 * detour line. Pure; returns the adjusted {x, y} per label id.
 */
export function layoutLabels(
  boxes: ReadonlyArray<LabelBox>,
): ReadonlyMap<string, { readonly x: number; readonly y: number }> {
  const PILL_HEIGHT = 16;
  const PAD_X = 6;
  const PAD_Y = 6;
  const result = new Map<string, { x: number; y: number }>();
  const placed: Array<{ x: number; y: number; w: number }> = [];
  const order = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const box of order) {
    let y = box.y;
    let conflict = true;
    let guard = 0;
    while (conflict && guard++ < 200) {
      conflict = false;
      for (const p of placed) {
        const minX = (box.w + p.w) / 2 + PAD_X;
        if (Math.abs(box.x - p.x) < minX && Math.abs(y - p.y) < PILL_HEIGHT + PAD_Y) {
          y = p.y + PILL_HEIGHT + PAD_Y;
          conflict = true;
          break;
        }
      }
    }
    placed.push({ x: box.x, y, w: box.w });
    result.set(box.id, { x: box.x, y });
  }
  return result;
}

function anchorPoint(
  anchorId: string,
  laneKey: string,
  layout: CanvasLayout,
  anchors: CanvasAnchors,
  role: "source" | "target",
): CanvasPoint {
  const measured = anchors[anchorId];
  if (measured) {
    return measured;
  }

  const laneLayout = layout.lanes.find((lane) => lane.laneKey === laneKey);
  if (!laneLayout) {
    return { x: 0, y: 0 };
  }

  if (role === "target") {
    return { x: laneLayout.x, y: laneLayout.y + laneLayout.estimatedHeight / 2 };
  }

  if (anchorId.includes("-action-")) {
    // The action index is always the final segment; splitting on the LAST
    // "-action-" keeps parsing correct even when laneKey itself contains it.
    const segments = anchorId.split("-action-");
    const actionIndex = Number(segments[segments.length - 1] ?? "0");
    return {
      x: laneLayout.x + LANE_CARD_WIDTH,
      y: laneLayout.y + laneLayout.estimatedHeight - 18 - actionIndex * 12,
    };
  }
  if (anchorId.includes("-on-failure")) {
    return { x: laneLayout.x + LANE_CARD_WIDTH, y: laneLayout.y + 56 };
  }
  if (anchorId.includes("-on-blocked")) {
    return { x: laneLayout.x + LANE_CARD_WIDTH, y: laneLayout.y + 74 };
  }
  if (anchorId.startsWith("step-")) {
    return { x: laneLayout.x + LANE_CARD_WIDTH, y: laneLayout.y + 110 };
  }
  return { x: laneLayout.x + LANE_CARD_WIDTH, y: laneLayout.y + 38 };
}

function selfLoopPath(source: CanvasPoint, target: CanvasPoint): string {
  const loopRight = source.x + 92;
  const loopTop = Math.min(source.y, target.y) - 56;
  return `M ${source.x} ${source.y} C ${loopRight} ${source.y}, ${loopRight} ${loopTop}, ${source.x + 28} ${loopTop} C ${target.x - 52} ${loopTop}, ${target.x - 52} ${target.y}, ${target.x} ${target.y}`;
}
