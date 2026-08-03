/**
 * The per-row slice of the commit lane graph.
 *
 * The graph itself is folded once, over the FULL contiguous newest-first entry
 * array, by `buildLaneGraph`; this component only draws the node it is handed.
 * Folding per visible window would silently produce a different — wrong — graph,
 * which is why the node arrives as a prop rather than being derived here.
 *
 * fork: f4 source-control panel
 */
import { memo } from "react";

import type { LaneNode } from "~/lib/sourceControl/laneGraph";

import {
  LANE_COLUMN_WIDTH,
  LANE_LINE_WIDTH,
  LANE_NODE_RADIUS,
  laneCenterX,
  laneColor,
} from "./laneGraphPalette";

interface LaneGraphRowProps {
  readonly node: LaneNode;
  /** Widest row in the whole graph, so every row's gutter lines up. */
  readonly width: number;
  readonly height: number;
  /** Merge commits get a ring rather than a filled dot. */
  readonly isMerge: boolean;
}

function LaneGraphRowImpl({ node, width, height, isMerge }: LaneGraphRowProps) {
  const pixelWidth = laneCenterX(Math.max(width, 1));
  const midY = height / 2;
  const nodeColor = laneColor(node.colorIndex);

  return (
    <svg
      width={pixelWidth}
      height={height}
      viewBox={`0 0 ${pixelWidth} ${height}`}
      className="shrink-0"
      aria-hidden
      focusable="false"
    >
      {node.connections.map((connection) => {
        const fromX = laneCenterX(connection.fromColumn);
        const toX = laneCenterX(connection.toColumn);
        const color = laneColor(connection.colorIndex);
        // A straight lane is a plain vertical; a merge-in / branch-out bends
        // through the row midpoint so the curve reads as one continuous line
        // across adjacent rows.
        const path =
          connection.kind === "straight" || fromX === toX
            ? `M ${fromX} 0 L ${toX} ${height}`
            : `M ${fromX} 0 C ${fromX} ${midY}, ${toX} ${midY}, ${toX} ${height}`;
        return (
          <path
            // Lane geometry is stable per (lane pair, kind, colour) within a
            // row; an array index would reshuffle strokes when a lane closes.
            key={`${connection.kind}:${connection.fromColumn}:${connection.toColumn}:${connection.colorIndex}`}
            d={path}
            fill="none"
            stroke={color}
            strokeWidth={LANE_LINE_WIDTH}
            strokeLinecap="round"
          />
        );
      })}
      <circle
        cx={laneCenterX(node.column)}
        cy={midY}
        r={LANE_NODE_RADIUS}
        fill={isMerge ? "var(--background)" : nodeColor}
        stroke={nodeColor}
        strokeWidth={isMerge ? LANE_LINE_WIDTH : 0}
      />
    </svg>
  );
}

export const LaneGraphRow = memo(LaneGraphRowImpl);

export function laneGutterPixelWidth(width: number): number {
  return laneCenterX(Math.max(width, 1)) + LANE_COLUMN_WIDTH / 2;
}
