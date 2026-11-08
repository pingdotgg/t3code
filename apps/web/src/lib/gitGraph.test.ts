import { describe, expect, it } from "vite-plus/test";

import { layoutGitGraph, LANE_WIDTH, rowGraph } from "./gitGraph";

const lanes = (row: { output: ReadonlyArray<{ id: string }> }) => row.output.map((lane) => lane.id);

describe("layoutGitGraph", () => {
  it("keeps a linear history in one lane", () => {
    const rows = layoutGitGraph([
      { sha: "c", parents: ["b"] },
      { sha: "b", parents: ["a"] },
      { sha: "a", parents: [] },
    ]);
    expect(rows.map(lanes)).toEqual([["b"], ["a"], []]);
    expect(rows.map((row) => rowGraph(row, 22).circle.cx)).toEqual([
      LANE_WIDTH,
      LANE_WIDTH,
      LANE_WIDTH,
    ]);
  });

  it("opens a lane at a merge and closes it where the branches meet", () => {
    // m merges f into b; f and b both descend from a.
    const rows = layoutGitGraph([
      { sha: "m", parents: ["b", "f"] },
      { sha: "f", parents: ["a"] },
      { sha: "b", parents: ["a"] },
      { sha: "a", parents: [] },
    ]);
    expect(rows.map(lanes)).toEqual([["b", "f"], ["b", "a"], ["a", "a"], []]);
    const [merge, feature, base, root] = rows.map((row) => rowGraph(row, 22));
    expect(merge!.circle.cx).toBe(LANE_WIDTH);
    expect(feature!.circle.cx).toBe(LANE_WIDTH * 2);
    expect(base!.circle.cx).toBe(LANE_WIDTH);
    // Both lanes converge on the root: its row draws a curve from the second lane.
    expect(root!.circle.cx).toBe(LANE_WIDTH);
    expect(root!.paths.some((path) => path.d.startsWith(`M ${LANE_WIDTH * 2} 0`))).toBe(true);
    // The merge's second-parent lane has its own color.
    expect(rows[0]!.output[1]!.color).not.toBe(rows[0]!.output[0]!.color);
  });

  it("keeps other lanes alive through a root commit", () => {
    const rows = layoutGitGraph([
      { sha: "m", parents: ["x", "y"] },
      { sha: "x", parents: [] },
      { sha: "y", parents: [] },
    ]);
    expect(rows.map(lanes)).toEqual([["x", "y"], ["y"], []]);
    expect(rowGraph(rows[2]!, 22).circle.cx).toBe(LANE_WIDTH);
  });
});
