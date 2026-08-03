/**
 * The commit-history lane graph.
 *
 * A topological fold over the FULL, contiguous, newest-first entry array. It is
 * window-dependent by construction: folding over a slice, a filtered list or a
 * reordered list produces different lanes, so `laneGraphSuppression` states the
 * conditions under which the panel must stop drawing it rather than draw
 * something quietly wrong.
 *
 * Lanes carry a `colorIndex` rather than a colour: the palette belongs to the
 * rendering layer, and keeping it out of here means the fold stays testable and
 * free of design tokens. Indices cycle at `LANE_COLOR_COUNT`, so the ordering
 * of allocations — which is behaviour, not styling — is still pinned.
 */

import type { WorkingCopyLogEntry } from "./types";

/** How many distinct lane colours the palette carries before it repeats. */
export const LANE_COLOR_COUNT = 8;

/** Nodes rendered without a meaningful lane (see `laneGraphSuppression`). */
export const LANE_COLOR_INDEX_NONE = -1;

export type LaneConnectionKind = "straight" | "merge-in" | "branch-out";

export interface LaneConnection {
  readonly fromColumn: number;
  readonly toColumn: number;
  readonly colorIndex: number;
  readonly kind: LaneConnectionKind;
}

export interface LaneNode {
  readonly hash: string;
  readonly column: number;
  readonly colorIndex: number;
  readonly connections: ReadonlyArray<LaneConnection>;
  /** Lanes open on the row below this one; drives the gutter width. */
  readonly laneCount: number;
}

interface Lane {
  hash: string;
  colorIndex: number;
}

/** A lane-less node for rows rendered while the graph is suppressed. */
export function plainLaneNode(hash: string): LaneNode {
  return {
    hash,
    column: 0,
    colorIndex: LANE_COLOR_INDEX_NONE,
    connections: [],
    laneCount: 1,
  };
}

export function buildLaneGraph(
  entries: ReadonlyArray<WorkingCopyLogEntry>,
): ReadonlyArray<LaneNode> {
  if (entries.length === 0) {
    return [];
  }

  // Each lane tracks which commit hash it is waiting for, and its colour.
  let lanes: Array<Lane | null> = [];
  const nodes: LaneNode[] = [];
  let nextColorIndex = 0;

  const allocateColorIndex = (): number => {
    const index = nextColorIndex % LANE_COLOR_COUNT;
    nextColorIndex += 1;
    return index;
  };

  for (const entry of entries) {
    const connections: LaneConnection[] = [];

    // Which lane is this commit occupying? Lanes are matched by hash.
    let column = lanes.findIndex((lane) => lane !== null && lane.hash === entry.hash);

    if (column === -1) {
      // New branch head — take the first free slot, or append one.
      column = lanes.findIndex((lane) => lane === null);
      if (column === -1) {
        column = lanes.length;
        lanes.push(null);
      }
      lanes[column] = { hash: entry.hash, colorIndex: allocateColorIndex() };
    }

    const nodeColorIndex = lanes[column]?.colorIndex ?? LANE_COLOR_INDEX_NONE;
    const parents = entry.parents;

    // Next row's lanes, starting from a copy of this row's.
    const nextLanes: Array<Lane | null> = lanes.map((lane) => (lane ? { ...lane } : null));

    const firstParent = parents[0];
    const extraParents = parents.slice(1);

    if (firstParent === undefined) {
      // Root commit — close this lane.
      nextLanes[column] = null;
    } else {
      // The first parent continues in this lane…
      nextLanes[column] = { hash: firstParent, colorIndex: nodeColorIndex };

      // …unless it is already carried by another lane, in which case this lane
      // converges into that one and closes here.
      const convergingLane = lanes.findIndex(
        (lane, index) => index !== column && lane !== null && lane.hash === firstParent,
      );
      if (convergingLane !== -1) {
        nextLanes[column] = null;
      }

      // Additional parents (a merge) each need a lane.
      for (const parentHash of extraParents) {
        const existingLane = nextLanes.findIndex(
          (lane) => lane !== null && lane.hash === parentHash,
        );
        if (existingLane === -1) {
          let newLane = nextLanes.findIndex((lane) => lane === null);
          if (newLane === -1) {
            newLane = nextLanes.length;
            nextLanes.push(null);
          }
          nextLanes[newLane] = { hash: parentHash, colorIndex: allocateColorIndex() };
        }
      }
    }

    // Pass-through lanes: present in both rows at the same column.
    for (let index = 0; index < Math.max(lanes.length, nextLanes.length); index += 1) {
      if (index === column) {
        // Handled separately below.
        continue;
      }
      const current = lanes[index] ?? null;
      const next = nextLanes[index] ?? null;
      if (current !== null && next !== null && current.hash === next.hash) {
        connections.push({
          fromColumn: index,
          toColumn: index,
          colorIndex: current.colorIndex,
          kind: "straight",
        });
      }
    }

    // This commit's own outgoing edges.
    if (firstParent !== undefined) {
      const firstParentColumn = nextLanes.findIndex(
        (lane) => lane !== null && lane.hash === firstParent,
      );
      if (firstParentColumn !== -1) {
        connections.push({
          fromColumn: column,
          toColumn: firstParentColumn,
          colorIndex: nodeColorIndex,
          kind: firstParentColumn === column ? "straight" : "merge-in",
        });
      }

      for (const parentHash of extraParents) {
        const parentColumn = nextLanes.findIndex(
          (lane) => lane !== null && lane.hash === parentHash,
        );
        if (parentColumn !== -1) {
          connections.push({
            fromColumn: column,
            toColumn: parentColumn,
            colorIndex: nextLanes[parentColumn]?.colorIndex ?? LANE_COLOR_INDEX_NONE,
            kind: "branch-out",
          });
        }
      }
    }

    // Lanes that shifted column between the two rows.
    for (let index = 0; index < lanes.length; index += 1) {
      if (index === column) {
        continue;
      }
      const current = lanes[index];
      if (current === null || current === undefined) {
        continue;
      }
      const nextIndex = nextLanes.findIndex((lane) => lane !== null && lane.hash === current.hash);
      if (nextIndex !== -1 && nextIndex !== index) {
        connections.push({
          fromColumn: index,
          toColumn: nextIndex,
          colorIndex: current.colorIndex,
          kind: "merge-in",
        });
      }
    }

    while (nextLanes.length > 0 && nextLanes[nextLanes.length - 1] === null) {
      nextLanes.pop();
    }

    nodes.push({
      hash: entry.hash,
      column,
      colorIndex: nodeColorIndex,
      connections,
      laneCount: Math.max(nextLanes.length, column + 1, 1),
    });

    lanes = nextLanes;
  }

  return nodes;
}

/** The gutter width the renderer needs: the widest row in the whole graph. */
export function laneGraphWidth(nodes: ReadonlyArray<LaneNode>): number {
  let width = 1;
  for (const node of nodes) {
    width = Math.max(width, node.laneCount, node.column + 1);
  }
  return width;
}

export type LaneGraphSuppressionReason = "filtered" | "sorted oldest-first" | "grouped by day";

export interface LaneGraphViewState {
  /** A text query or author filter is narrowing the list. */
  readonly filtered: boolean;
  readonly sort: "newest" | "oldest";
  readonly grouped: boolean;
}

/**
 * Whether the lane graph is meaningful for the list the user is looking at, and
 * — when it is not — WHY, so the panel can say so instead of quietly dropping
 * to unconnected dots. A graph folded over a filtered window is silently wrong,
 * which is worse than no graph.
 *
 * Every reason is reversible by resetting the view, so the notice can offer a
 * one-click restore.
 */
export function laneGraphSuppression(view: LaneGraphViewState): LaneGraphSuppressionReason | null {
  if (view.filtered) {
    return "filtered";
  }
  if (view.sort === "oldest") {
    return "sorted oldest-first";
  }
  if (view.grouped) {
    return "grouped by day";
  }
  return null;
}

export function isLaneGraphMeaningful(view: LaneGraphViewState): boolean {
  return laneGraphSuppression(view) === null;
}
