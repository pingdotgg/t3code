export const LANE_CARD_WIDTH = 240;
export const LANE_GAP_X = 72;
export const LANE_GAP_Y = 48;

// Fan-out spacing between parallel edges that share one card side.
const PORT_SPACING = 18;
// Local-detour geometry: how far below the cards a detour's first track sits,
// and the vertical gap between stacked detour tracks.
export const DETOUR_CLEARANCE = 28;
export const DETOUR_TRACK_GAP = 24;
// Horizontal padding when deciding whether a card sits under a detour's run, and
// when deciding whether two detour runs overlap (so they pack into tracks).
const DETOUR_CARD_PAD = 10;
const DETOUR_OVERLAP_PAD = 20;
// Corner radius for the orthogonal detour elbows.
const DETOUR_RADIUS = 10;

export interface EdgeRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RoutedEdgePath {
  readonly d: string;
  readonly labelX: number;
  readonly labelY: number;
  /** Approximate path length, for pacing direction particles at constant speed. */
  readonly length: number;
}

export type EdgeGeometry =
  | { readonly kind: "forward" }
  | { readonly kind: "vertical" }
  | { readonly kind: "channel" };

/**
 * Classify how an edge should travel based on where its lanes actually sit:
 * - forward: target is in the next column to the right — a direct curve
 *   between facing sides stays in the column gap and reads cleanly.
 * - vertical: lanes overlap horizontally (same column) — a short curve
 *   between bottom and top edges.
 * - channel: anything longer (multi-column spans and back-edges) detours
 *   locally through the clear space just below the cards it spans, hugging
 *   that row rather than escaping to a global corridor at the band edge.
 */
export const classifyEdge = (source: EdgeRect, target: EdgeRect): EdgeGeometry => {
  const horizontalOverlap =
    Math.min(source.x + source.width, target.x + target.width) > Math.max(source.x, target.x);
  if (horizontalOverlap) {
    return { kind: "vertical" };
  }
  const forwardGap = target.x - (source.x + source.width);
  if (forwardGap >= 0 && forwardGap <= LANE_GAP_X + LANE_CARD_WIDTH / 2) {
    return { kind: "forward" };
  }
  return { kind: "channel" };
};

export type CardSide = "left" | "right" | "top" | "bottom";

/**
 * The physical card side each endpoint of an edge attaches to. Several edge
 * geometries share a side, so port slots must be allocated per side — not per
 * geometry kind — or edges of different kinds stack on one point. Channel
 * detours leave and re-enter through the BOTTOM (they drop into the local lane
 * below the cards), so they share the bottom slot group with vertical-down
 * edges and fan out cleanly.
 */
export const edgeEndpointSides = (
  source: EdgeRect,
  target: EdgeRect,
): { readonly source: CardSide; readonly target: CardSide } => {
  const geometry = classifyEdge(source, target);
  if (geometry.kind === "forward") {
    return { source: "right", target: "left" };
  }
  if (geometry.kind === "vertical") {
    const goingDown = target.y >= source.y + source.height;
    return goingDown ? { source: "bottom", target: "top" } : { source: "top", target: "bottom" };
  }
  return { source: "bottom", target: "bottom" };
};

const portOffset = (slot: number, count: number): number => (slot - (count - 1) / 2) * PORT_SPACING;

const center = (rect: EdgeRect): number => rect.x + rect.width / 2;

export interface EdgeRouteInput {
  readonly source: EdgeRect;
  readonly target: EdgeRect;
  /** Slot/count along the chosen source side, to fan out parallel edges. */
  readonly sourceSlot: number;
  readonly sourceCount: number;
  readonly targetSlot: number;
  readonly targetCount: number;
}

/**
 * Route a forward (next-column) or vertical (same-column) edge as a short
 * cubic curve between the facing card sides. Channel (multi-column / back) edges
 * are routed by {@link routeDetour} instead, which needs a packed track Y.
 */
export const routeEdge = (input: EdgeRouteInput): RoutedEdgePath => {
  const geometry = classifyEdge(input.source, input.target);

  if (geometry.kind === "vertical") {
    const goingDown = input.target.y >= input.source.y + input.source.height;
    const sx = center(input.source) + portOffset(input.sourceSlot, input.sourceCount);
    const tx = center(input.target) + portOffset(input.targetSlot, input.targetCount);
    const sy = goingDown ? input.source.y + input.source.height : input.source.y;
    const ty = goingDown ? input.target.y : input.target.y + input.target.height;
    const delta = Math.max(24, Math.abs(ty - sy) / 2);
    const sign = goingDown ? 1 : -1;
    return {
      d: `M ${sx} ${sy} C ${sx} ${sy + sign * delta}, ${tx} ${ty - sign * delta}, ${tx} ${ty}`,
      labelX: (sx + tx) / 2,
      labelY: (sy + ty) / 2,
      length: Math.hypot(tx - sx, ty - sy) * 1.15,
    };
  }

  // forward (also the fallback): curve between facing right/left sides.
  const sx = input.source.x + input.source.width;
  const sy =
    input.source.y + input.source.height / 2 + portOffset(input.sourceSlot, input.sourceCount);
  const tx = input.target.x;
  const ty =
    input.target.y + input.target.height / 2 + portOffset(input.targetSlot, input.targetCount);
  const delta = Math.max(32, (tx - sx) / 2);
  return {
    d: `M ${sx} ${sy} C ${sx + delta} ${sy}, ${tx - delta} ${ty}, ${tx} ${ty}`,
    labelX: (sx + tx) / 2,
    labelY: (sy + ty) / 2,
    length: Math.hypot(tx - sx, ty - sy) * 1.15,
  };
};

/**
 * Route a channel (multi-column / back) edge as an orthogonal local detour: drop
 * out of the source's bottom, run along a horizontal track `laneY` (assigned by
 * {@link packDetourLanes} so parallel detours never overlap), then rise into the
 * target's bottom. `laneY` sits just below the cards the run passes over, so the
 * line hugs that row instead of swinging out to the band edge.
 */
export const routeDetour = (input: EdgeRouteInput & { readonly laneY: number }): RoutedEdgePath => {
  const r = DETOUR_RADIUS;
  const sx = center(input.source) + portOffset(input.sourceSlot, input.sourceCount);
  const tx = center(input.target) + portOffset(input.targetSlot, input.targetCount);
  const sy = input.source.y + input.source.height;
  const ty = input.target.y + input.target.height;
  const y = input.laneY;
  const dirH = Math.sign(tx - sx) || 1;
  return {
    d: [
      `M ${sx} ${sy}`,
      `L ${sx} ${y - r}`,
      `Q ${sx} ${y} ${sx + dirH * r} ${y}`,
      `L ${tx - dirH * r} ${y}`,
      `Q ${tx} ${y} ${tx} ${y - r}`,
      `L ${tx} ${ty}`,
    ].join(" "),
    labelX: (sx + tx) / 2,
    labelY: y,
    length: y - sy + Math.abs(tx - sx) + (y - ty),
  };
};

/**
 * The bottom-most card edge under a detour's horizontal run. A detour track must
 * sit below every card it passes over (not just its endpoints) or it would cut
 * through a taller mid-card. Returns 0 when the run clears no cards.
 */
export const clearBottomForSpan = (
  left: number,
  right: number,
  cards: ReadonlyArray<EdgeRect>,
): number => {
  let bottom = 0;
  for (const card of cards) {
    if (card.x + card.width > left - DETOUR_CARD_PAD && card.x < right + DETOUR_CARD_PAD) {
      bottom = Math.max(bottom, card.y + card.height);
    }
  }
  return bottom;
};

export interface DetourSpan {
  /** Left/right x of the detour's horizontal run (the two drop points). */
  readonly left: number;
  readonly right: number;
  /** Bottom-most card under the run (from {@link clearBottomForSpan}). */
  readonly clearBottom: number;
}

/**
 * Assign each detour a horizontal track Y. Each detour starts as high as the
 * cards it spans allow (tight), then is bumped down one track gap whenever it
 * would collide with an already-placed detour whose horizontal run overlaps —
 * so parallel back-edges stack into clear lanes instead of landing on top of
 * each other. Returns the per-span track Y (input order) and the deepest track
 * (so the layout can reserve room below the cards for it).
 */
export const packDetourLanes = (
  spans: ReadonlyArray<DetourSpan>,
): { readonly lanes: ReadonlyArray<number>; readonly extent: number } => {
  const order = spans
    .map((span, index) => ({ span, index }))
    .sort((a, b) => a.span.left - b.span.left);
  const lanes = new Array<number>(spans.length).fill(0);
  const placed: Array<{ left: number; right: number; y: number }> = [];
  let extent = 0;
  for (const { span, index } of order) {
    let y = span.clearBottom + DETOUR_CLEARANCE;
    let bump = true;
    let guard = 0;
    while (bump && guard++ < 200) {
      bump = false;
      for (const p of placed) {
        const xOverlap =
          span.left < p.right + DETOUR_OVERLAP_PAD && p.left < span.right + DETOUR_OVERLAP_PAD;
        if (xOverlap && Math.abs(p.y - y) < DETOUR_TRACK_GAP - 1) {
          y = p.y + DETOUR_TRACK_GAP;
          bump = true;
          break;
        }
      }
    }
    lanes[index] = y;
    placed.push({ left: span.left, right: span.right, y });
    extent = Math.max(extent, y);
  }
  return { lanes, extent };
};
