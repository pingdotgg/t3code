import type { TaskGraphNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  layoutTaskGraph,
  TASK_GRAPH_CANVAS_NODE_HEIGHT,
  TASK_GRAPH_CANVAS_NODE_WIDTH,
  taskGraphCanvasElements,
  taskGraphLayoutSignature,
} from "./taskGraphCanvasLayout";

const node = (key: string, dependsOn: string[] = [], overrides: Partial<TaskGraphNode> = {}) =>
  ({
    key,
    title: key,
    prompt: "Do it",
    dependsOn,
    pullRequest: null,
    modelSelection: null,
    environmentId: null,
    status: "pending",
    assignedEnvironmentId: null,
    threadId: null,
    branch: null,
    summary: null,
    error: null,
    pullRequestResult: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  }) satisfies TaskGraphNode;

// a -> b, a -> c, (b, c) -> d
const diamond = [node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b", "c"])];

const overlaps = (
  first: { readonly x: number; readonly y: number },
  second: { readonly x: number; readonly y: number },
) =>
  Math.abs(first.x - second.x) < TASK_GRAPH_CANVAS_NODE_WIDTH &&
  Math.abs(first.y - second.y) < TASK_GRAPH_CANVAS_NODE_HEIGHT;

describe("layoutTaskGraph", () => {
  it("places every dependency to the left of the nodes that wait on it", () => {
    const positions = layoutTaskGraph(diamond);
    for (const current of diamond) {
      for (const dependency of current.dependsOn) {
        expect(positions.get(dependency)!.x).toBeLessThan(positions.get(current.key)!.x);
      }
    }
  });

  it("does not overlap nodes", () => {
    const positions = [...layoutTaskGraph(diamond).values()];
    for (const [index, position] of positions.entries()) {
      for (const other of positions.slice(index + 1)) {
        expect(overlaps(position, other)).toBe(false);
      }
    }
  });

  it("ignores dependencies on nodes that are not in the graph", () => {
    const positions = layoutTaskGraph([node("a", ["gone"])]);
    expect([...positions.keys()]).toEqual(["a"]);
  });
});

describe("taskGraphLayoutSignature", () => {
  it("changes with structure but not with status", () => {
    const running = diamond.map((current) => ({ ...current, status: "running" as const }));
    expect(taskGraphLayoutSignature(running)).toBe(taskGraphLayoutSignature(diamond));
    expect(taskGraphLayoutSignature([...diamond, node("e", ["d"])])).not.toBe(
      taskGraphLayoutSignature(diamond),
    );
  });
});

describe("taskGraphCanvasElements", () => {
  it("draws one edge per dependency from the dependency to the dependent", () => {
    const { nodes, edges } = taskGraphCanvasElements(diamond, layoutTaskGraph(diamond), {
      nodeKey: "b",
      edgeId: "c->d",
    });
    expect(edges.map((edge) => [edge.source, edge.target, edge.selected])).toEqual([
      ["a", "b", false],
      ["a", "c", false],
      ["b", "d", false],
      ["c", "d", true],
    ]);
    expect(nodes.filter((current) => current.selected).map((current) => current.id)).toEqual(["b"]);
  });

  it("marks which nodes open a pull request", () => {
    const { nodes } = taskGraphCanvasElements(diamond, layoutTaskGraph(diamond), {
      nodeKey: null,
      edgeId: null,
    });
    expect(nodes.map((current) => [current.id, current.data.opensPullRequest])).toEqual([
      ["a", false],
      ["b", false],
      ["c", false],
      ["d", true],
    ]);
  });
});
