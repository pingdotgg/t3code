import { describe, expect, it } from "vite-plus/test";
import {
  buildLaneGraph,
  cappedLaneGraphWidth,
  isLaneGraphMeaningful,
  LANE_GRAPH_MAX_WIDTH,
  laneGraphSuppression,
  laneGraphWidth,
  plainLaneNode,
  LANE_COLOR_COUNT,
  LANE_COLOR_INDEX_NONE,
  type LaneGraphViewState,
  type LaneNode,
} from "./laneGraph";
import type { WorkingCopyLogEntry } from "./types";

// CHARACTERIZATION SUITE — pins what the fold does so a virtualization or
// rendering change cannot alter lane layout silently. Where the behaviour looks
// wrong it is asserted as-is and flagged with a NOTE.

/** Log entries are newest-first; only `hash` and `parents` affect the graph. */
function entry(hash: string, parents: ReadonlyArray<string>): WorkingCopyLogEntry {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    subject: `subject ${hash}`,
    authorName: "Ada",
    authorEmail: "ada@example.com",
    authoredAt: "2026-01-01T00:00:00Z",
    parents,
  };
}

/** Compact, diff-readable rendering of a node's connections: "from->to:kind". */
function connections(node: LaneNode | undefined): ReadonlyArray<string> {
  expect(node).toBeDefined();
  return (node?.connections ?? []).map(
    (edge) => `${edge.fromColumn}->${edge.toColumn}:${edge.kind}`,
  );
}

/** Look a node up by hash; fails loudly rather than asserting on undefined. */
function nodeLookup(nodes: ReadonlyArray<LaneNode>): (hash: string) => LaneNode {
  const byHash = new Map(nodes.map((node) => [node.hash, node]));
  return (hash) => {
    const node = byHash.get(hash);
    expect(node).toBeDefined();
    return node as LaneNode;
  };
}

// --- Fixtures -------------------------------------------------------------

/** c1 → c2 → c3, with c3 a true root (no parents). */
const LINEAR = [entry("c1", ["c2"]), entry("c2", ["c3"]), entry("c3", [])];

/** Same chain, but the window ends before the root (c4 is off-window). */
const LINEAR_OPEN_TAIL = [entry("c1", ["c2"]), entry("c2", ["c3"]), entry("c3", ["c4"])];

/** Classic two-parent merge that reconverges on a shared base. */
const MERGE = [
  entry("m", ["a", "b"]),
  entry("a", ["base"]),
  entry("b", ["base"]),
  entry("base", []),
];

/** Three-parent (octopus) merge over the same base. */
const OCTOPUS = [
  entry("o", ["a", "b", "c"]),
  entry("a", ["base"]),
  entry("b", ["base"]),
  entry("c", ["base"]),
  entry("base", []),
];

/** `log -n 2` cutting through a merge: "missing" is never listed. */
const TRUNCATED_MERGE = [entry("m", ["a", "missing"]), entry("a", [])];

/** Same truncation with rows after it, to watch the orphaned lane persist. */
const TRUNCATED_MERGE_LONG = [entry("m", ["a", "missing"]), entry("a", ["a2"]), entry("a2", [])];

/** Two disjoint histories in one window (graft / imported subtree). */
const TWO_ROOTS = [entry("x1", ["x2"]), entry("x2", []), entry("y1", ["y2"]), entry("y2", [])];

/** A merge joining two histories that each have their own root. */
const GRAFT_MERGE = [
  entry("m", ["x1", "y1"]),
  entry("x1", ["x2"]),
  entry("y1", ["y2"]),
  entry("x2", []),
  entry("y2", []),
];

/** 9 simultaneous parents — one more than the palette carries. */
const OCTOPUS_9 = [
  entry("big", ["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]),
  ...Array.from({ length: 9 }, (_, index) => entry(`p${index}`, [])),
];

// --- Tests ----------------------------------------------------------------

describe("buildLaneGraph — degenerate input", () => {
  it("returns an empty array for empty input", () => {
    expect(buildLaneGraph([])).toEqual([]);
  });

  it("handles a lone orphan root without throwing", () => {
    const nodes = buildLaneGraph([entry("solo", [])]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.column).toBe(0);
    expect(nodes[0]!.colorIndex).toBe(0);
    expect(nodes[0]!.laneCount).toBe(1);
    expect(nodes[0]!.connections).toEqual([]);
  });

  it("does not mutate the input entries", () => {
    const input = LINEAR.map((item) => ({ ...item, parents: [...item.parents] }));
    const before = JSON.stringify(input);
    buildLaneGraph(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("buildLaneGraph — linear history", () => {
  const nodes = buildLaneGraph(LINEAR);

  it("emits one node per entry, in input order", () => {
    expect(nodes.map((node) => node.hash)).toEqual(["c1", "c2", "c3"]);
  });

  it("keeps every commit on lane 0 with the first palette colour", () => {
    expect(nodes.map((node) => node.column)).toEqual([0, 0, 0]);
    expect(nodes.map((node) => node.colorIndex)).toEqual([0, 0, 0]);
  });

  it("draws a single straight 0->0 connection per non-root row", () => {
    expect(connections(nodes[0])).toEqual(["0->0:straight"]);
    expect(connections(nodes[1])).toEqual(["0->0:straight"]);
  });

  it("terminates the lane at the root (no outgoing connection)", () => {
    expect(connections(nodes[2])).toEqual([]);
  });

  it("reports laneCount 1 on every row", () => {
    expect(nodes.map((node) => node.laneCount)).toEqual([1, 1, 1]);
    expect(laneGraphWidth(nodes)).toBe(1);
  });

  it("still draws a straight connection when the tail parent is off-window", () => {
    const open = buildLaneGraph(LINEAR_OPEN_TAIL);
    // NOTE: c3's parent c4 is not in the window, yet the lane stays open and a
    // straight connection is drawn off the bottom edge of the last row.
    expect(connections(open[2])).toEqual(["0->0:straight"]);
    expect(open[2]!.laneCount).toBe(1);
  });
});

describe("buildLaneGraph — two-parent merge", () => {
  const nodes = buildLaneGraph(MERGE);
  const at = nodeLookup(nodes);

  it("places the merge on lane 0 and its second parent on lane 1", () => {
    expect([at("m").column, at("a").column, at("b").column, at("base").column]).toEqual([
      0, 0, 1, 0,
    ]);
  });

  it("colours the new lane with the next palette entry", () => {
    expect([
      at("m").colorIndex,
      at("a").colorIndex,
      at("b").colorIndex,
      at("base").colorIndex,
    ]).toEqual([0, 0, 1, 0]);
  });

  it("emits straight (first parent) + branch-out (second parent) at the merge", () => {
    expect(connections(at("m"))).toEqual(["0->0:straight", "0->1:branch-out"]);
    expect(at("m").connections[1]!.colorIndex).toBe(1);
  });

  it("passes the idle side lane straight through intermediate rows", () => {
    // Pass-through lanes are emitted before the row's own lane connection.
    expect(connections(at("a"))).toEqual(["1->1:straight", "0->0:straight"]);
  });

  it("collapses the side lane back with merge-in when it reaches the shared base", () => {
    expect(connections(at("b"))).toEqual(["0->0:straight", "1->0:merge-in"]);
    const mergeIn = at("b").connections.find((edge) => edge.kind === "merge-in");
    expect(mergeIn?.colorIndex).toBe(1);
  });

  it("terminates at the base with no connections", () => {
    expect(connections(at("base"))).toEqual([]);
  });

  it("reports laneCount 2 while the branch is open and 1 after it closes", () => {
    expect(nodes.map((node) => node.laneCount)).toEqual([2, 2, 2, 1]);
    expect(laneGraphWidth(nodes)).toBe(2);
  });
});

describe("buildLaneGraph — octopus merge (3 parents)", () => {
  const nodes = buildLaneGraph(OCTOPUS);
  const at = nodeLookup(nodes);

  it("allocates one lane per extra parent", () => {
    expect([at("o").column, at("a").column, at("b").column, at("c").column]).toEqual([0, 0, 1, 2]);
    expect(laneGraphWidth(nodes)).toBe(3);
  });

  it("emits one branch-out per additional parent, in parent order", () => {
    expect(connections(at("o"))).toEqual(["0->0:straight", "0->1:branch-out", "0->2:branch-out"]);
    expect(at("o").connections.map((edge) => edge.colorIndex)).toEqual([0, 1, 2]);
  });

  it("merges each extra lane back into lane 0 as it reaches the base", () => {
    expect(connections(at("b"))).toEqual(["0->0:straight", "2->2:straight", "1->0:merge-in"]);
    expect(connections(at("c"))).toEqual(["0->0:straight", "2->0:merge-in"]);
  });

  it("drops back to a single lane once all sides have converged", () => {
    expect(nodes.map((node) => node.laneCount)).toEqual([3, 3, 3, 3, 1]);
  });
});

describe("buildLaneGraph — merge parent outside the log window", () => {
  it("does not throw and still emits one node per entry", () => {
    expect(() => buildLaneGraph(TRUNCATED_MERGE)).not.toThrow();
    expect(buildLaneGraph(TRUNCATED_MERGE).map((node) => node.hash)).toEqual(["m", "a"]);
  });

  it("allocates a lane for the off-window parent anyway", () => {
    const nodes = buildLaneGraph(TRUNCATED_MERGE);
    expect(connections(nodes[0])).toEqual(["0->0:straight", "0->1:branch-out"]);
    expect(nodes[0]!.laneCount).toBe(2);
  });

  it("leaves the off-window lane dangling for the rest of the window", () => {
    const nodes = buildLaneGraph(TRUNCATED_MERGE);
    // NOTE: SUSPICIOUS — "missing" is never listed, so lane 1 never closes. The
    // final row emits a pass-through into a row that does not exist.
    expect(connections(nodes[1])).toEqual(["1->1:straight"]);
    expect(nodes[1]!.laneCount).toBe(2);
    expect(laneGraphWidth(nodes)).toBe(2);
  });

  it("keeps the dangling lane alive across every subsequent row", () => {
    const nodes = buildLaneGraph(TRUNCATED_MERGE_LONG);
    expect(connections(nodes[1])).toEqual(["1->1:straight", "0->0:straight"]);
    expect(connections(nodes[2])).toEqual(["1->1:straight"]);
    expect(nodes.map((node) => node.laneCount)).toEqual([2, 2, 2]);
  });
});

describe("buildLaneGraph — multiple roots in one window", () => {
  const nodes = buildLaneGraph(TWO_ROOTS);
  const at = nodeLookup(nodes);

  it("reuses lane 0 for the second root chain once the first has closed", () => {
    expect(nodes.map((node) => node.column)).toEqual([0, 0, 0, 0]);
    expect(laneGraphWidth(nodes)).toBe(1);
  });

  it("gives the second root chain a fresh colour despite reusing lane 0", () => {
    // NOTE: colour allocation always advances, so lane 0's colour changes
    // mid-column with no connection joining the two chains.
    expect([at("x1").colorIndex, at("x2").colorIndex]).toEqual([0, 0]);
    expect([at("y1").colorIndex, at("y2").colorIndex]).toEqual([1, 1]);
  });

  it("emits no connection between the two disjoint chains", () => {
    expect(connections(at("x2"))).toEqual([]);
    expect(connections(at("y1"))).toEqual(["0->0:straight"]);
  });

  it("keeps both sides of a graft merge on their own lanes down to their roots", () => {
    const graft = buildLaneGraph(GRAFT_MERGE);
    const at2 = nodeLookup(graft);
    expect([
      at2("m").column,
      at2("x1").column,
      at2("y1").column,
      at2("x2").column,
      at2("y2").column,
    ]).toEqual([0, 0, 1, 0, 1]);
    expect(connections(at2("m"))).toEqual(["0->0:straight", "0->1:branch-out"]);
    expect(connections(at2("x2"))).toEqual(["1->1:straight"]);
    expect(connections(at2("y2"))).toEqual([]);
    expect(laneGraphWidth(graft)).toBe(2);
  });
});

describe("buildLaneGraph — lane width and colour allocation", () => {
  it("exposes a per-row laneCount that varies, not a constant graph width", () => {
    const nodes = buildLaneGraph(MERGE);
    expect(new Set(nodes.map((node) => node.laneCount))).toEqual(new Set([2, 1]));
    expect(laneGraphWidth(nodes)).toBe(2);
  });

  it("derives the gutter width from the whole entry set, not the widest row index", () => {
    const nodes = buildLaneGraph(OCTOPUS_9);
    expect(nodes[0]!.column).toBe(0);
    expect(nodes.every((node) => node.laneCount === 9)).toBe(true);
    expect(laneGraphWidth(nodes)).toBe(9);
  });

  it("cycles the palette after LANE_COLOR_COUNT lanes", () => {
    const nodes = buildLaneGraph(OCTOPUS_9);
    expect(LANE_COLOR_COUNT).toBe(8);
    expect(nodes.map((node) => node.colorIndex)).toEqual([
      0, 0, 1, 2, 3, 4, 5, 6, 7,
      // NOTE: the 9th lane wraps back onto the first colour.
      0,
    ]);
  });

  it("is window-dependent: a sliced entry list yields a different graph", () => {
    // Guard for virtualization — the fold must keep seeing the full,
    // contiguous, newest-first window. Building only the visible tail loses lanes.
    const full = buildLaneGraph(MERGE);
    const sliced = buildLaneGraph(MERGE.slice(2));
    expect(full.slice(2).map((node) => node.column)).toEqual([1, 0]);
    expect(sliced.map((node) => node.column)).toEqual([0, 0]);
    expect(laneGraphWidth(sliced)).toBe(1);
    expect(laneGraphWidth(full)).toBe(2);
  });

  it("opens a brand-new lane for a commit that is nobody's tracked parent", () => {
    const nodes = buildLaneGraph([
      entry("m1", ["a", "b"]),
      entry("m2", ["a", "b"]),
      entry("a", []),
      entry("b", []),
    ]);
    // NOTE: SUSPICIOUS — m2 lands on lane 2, widening the graph to 3 lanes even
    // though only two lanes carry real history.
    expect(nodes.map((node) => node.column)).toEqual([0, 2, 0, 1]);
    expect(laneGraphWidth(nodes)).toBe(3);
    expect(connections(nodes[1])).toEqual([
      "0->0:straight",
      "1->1:straight",
      "2->0:merge-in",
      "2->1:branch-out",
    ]);
  });

  it("emits overlapping self-connections for a duplicated parent hash", () => {
    const nodes = buildLaneGraph([entry("m", ["a", "a"]), entry("a", [])]);
    // NOTE: SUSPICIOUS — parents ["a","a"] produces two connections on the same
    // column, one straight and one branch-out, drawn on top of each other.
    expect(connections(nodes[0])).toEqual(["0->0:straight", "0->0:branch-out"]);
    expect(nodes[0]!.laneCount).toBe(1);
  });

  it("treats a non-topological window (parent listed first) as two lane runs", () => {
    const nodes = buildLaneGraph([entry("parent", []), entry("child", ["parent"])]);
    // NOTE: the parent row closes its lane before the child is seen, so the
    // child starts a fresh lane and the edge between them is never drawn.
    expect(nodes.map((node) => node.column)).toEqual([0, 0]);
    expect(nodes.map((node) => node.colorIndex)).toEqual([0, 1]);
    expect(connections(nodes[0])).toEqual([]);
    expect(connections(nodes[1])).toEqual(["0->0:straight"]);
  });
});

describe("buildLaneGraph — determinism", () => {
  const fixtures: ReadonlyArray<[string, ReadonlyArray<WorkingCopyLogEntry>]> = [
    ["linear", LINEAR],
    ["merge", MERGE],
    ["octopus", OCTOPUS],
    ["truncated merge", TRUNCATED_MERGE_LONG],
    ["two roots", TWO_ROOTS],
    ["graft merge", GRAFT_MERGE],
    ["octopus-9", OCTOPUS_9],
  ];

  it.each(fixtures)("yields deeply-equal output on repeat calls (%s)", (_name, entries) => {
    expect(buildLaneGraph(entries)).toEqual(buildLaneGraph(entries));
  });

  it("does not carry lane state between calls", () => {
    const first = buildLaneGraph(MERGE);
    buildLaneGraph(OCTOPUS);
    expect(buildLaneGraph(MERGE)).toEqual(first);
  });
});

describe("laneGraphSuppression", () => {
  const view = (over: Partial<LaneGraphViewState> = {}): LaneGraphViewState => ({
    filtered: false,
    sort: "newest",
    grouped: false,
    ...over,
  });

  it("is meaningful only on the unfiltered, newest-first, ungrouped list", () => {
    expect(laneGraphSuppression(view())).toBeNull();
    expect(isLaneGraphMeaningful(view())).toBe(true);
  });

  it("names the reason so the panel can SAY the graph is hidden", () => {
    expect(laneGraphSuppression(view({ filtered: true }))).toBe("filtered");
    expect(laneGraphSuppression(view({ sort: "oldest" }))).toBe("sorted oldest-first");
    expect(laneGraphSuppression(view({ grouped: true }))).toBe("grouped by day");
  });

  it("reports the filter first when several conditions hold at once", () => {
    expect(laneGraphSuppression(view({ filtered: true, sort: "oldest", grouped: true }))).toBe(
      "filtered",
    );
  });

  it("is never meaningful while any condition holds", () => {
    for (const over of [{ filtered: true }, { sort: "oldest" as const }, { grouped: true }]) {
      expect(isLaneGraphMeaningful(view(over))).toBe(false);
    }
  });
});

describe("plainLaneNode", () => {
  it("carries no lane at all — the absence of a lane, not a lane of its own", () => {
    expect(plainLaneNode("abc")).toEqual({
      hash: "abc",
      column: 0,
      colorIndex: LANE_COLOR_INDEX_NONE,
      connections: [],
      laneCount: 1,
    });
  });

  it("never collides with a real palette index", () => {
    expect(LANE_COLOR_INDEX_NONE).toBeLessThan(0);
  });
});

// ─── Gutter cap (audit §8 / M14) ───────────────────────────────────────────
//
// `laneGraphWidth` is the widest row in the WHOLE loaded page, so one six-lane
// stretch 150 commits down used to indent every row by 86px — a quarter of a
// 360px panel — and truncate every subject that much earlier, for the whole
// list. The fold is untouched; only the reserved gutter is bounded.

describe("cappedLaneGraphWidth", () => {
  it("leaves a narrow graph exactly as wide as it is", () => {
    expect(cappedLaneGraphWidth(1)).toBe(1);
    expect(cappedLaneGraphWidth(3)).toBe(3);
    expect(cappedLaneGraphWidth(LANE_GRAPH_MAX_WIDTH)).toBe(LANE_GRAPH_MAX_WIDTH);
  });

  it("caps a pathological page at the panel's budget", () => {
    expect(cappedLaneGraphWidth(9)).toBe(LANE_GRAPH_MAX_WIDTH);
    expect(cappedLaneGraphWidth(120)).toBe(LANE_GRAPH_MAX_WIDTH);
  });

  it("never returns less than one lane", () => {
    expect(cappedLaneGraphWidth(0)).toBe(1);
    expect(cappedLaneGraphWidth(-4)).toBe(1);
    expect(cappedLaneGraphWidth(Number.NaN)).toBe(1);
  });

  it("does not change the fold — nodes keep their true columns", () => {
    // A wide graph still reports its real width; only the gutter is capped.
    const nodes = buildLaneGraph([
      { hash: "a", parents: ["b"] },
      { hash: "b", parents: ["c"] },
      { hash: "c", parents: [] },
    ] as never);
    expect(laneGraphWidth(nodes)).toBeGreaterThanOrEqual(1);
  });
});
