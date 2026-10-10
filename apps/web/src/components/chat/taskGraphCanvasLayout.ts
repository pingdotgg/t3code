import dagre from "@dagrejs/dagre";
import type { TaskGraphNode } from "@t3tools/contracts";
import { taskGraphNodeOpensPullRequest } from "@t3tools/shared/taskGraph";
import type { Edge, Node } from "@xyflow/react";

/**
 * Turns a task graph into canvas nodes and edges. Only the lazily loaded
 * editor imports this, so dagre and xyflow stay out of the main bundle.
 */

export const TASK_GRAPH_CANVAS_NODE_WIDTH = 224;
export const TASK_GRAPH_CANVAS_NODE_HEIGHT = 64;

export type TaskGraphCanvasNodeData = {
  readonly node: TaskGraphNode;
  readonly opensPullRequest: boolean;
};
export type TaskGraphCanvasNode = Node<TaskGraphCanvasNodeData, "task">;

export type TaskGraphCanvasEdgeData = {
  readonly dependency: string;
  readonly dependent: string;
};
export type TaskGraphCanvasEdge = Edge<TaskGraphCanvasEdgeData>;

export interface TaskGraphCanvasPoint {
  readonly x: number;
  readonly y: number;
}

export const taskGraphCanvasEdgeId = (dependency: string, dependent: string): string =>
  `${dependency}->${dependent}`;

/**
 * Changes only when nodes or dependencies change, so status updates from a
 * running graph reuse the previous layout instead of running dagre again.
 */
export function taskGraphLayoutSignature(nodes: ReadonlyArray<TaskGraphNode>): string {
  return nodes.map((node) => `${node.key}:${node.dependsOn.join(",")}`).join("|");
}

/** Top-left canvas positions by node key, flowing left to right from dependencies. */
export function layoutTaskGraph(
  nodes: ReadonlyArray<TaskGraphNode>,
): ReadonlyMap<string, TaskGraphCanvasPoint> {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 64, marginx: 16, marginy: 16 });
  graph.setDefaultEdgeLabel(() => ({}));
  const keys = new Set(nodes.map((node) => node.key));
  for (const node of nodes) {
    graph.setNode(node.key, {
      width: TASK_GRAPH_CANVAS_NODE_WIDTH,
      height: TASK_GRAPH_CANVAS_NODE_HEIGHT,
    });
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (keys.has(dependency)) graph.setEdge(dependency, node.key);
    }
  }
  dagre.layout(graph);
  const positions = new Map<string, TaskGraphCanvasPoint>();
  for (const node of nodes) {
    const { x = 0, y = 0 } = graph.node(node.key) ?? {};
    // Dagre reports centers; the canvas positions nodes by their top-left corner.
    positions.set(node.key, {
      x: x - TASK_GRAPH_CANVAS_NODE_WIDTH / 2,
      y: y - TASK_GRAPH_CANVAS_NODE_HEIGHT / 2,
    });
  }
  return positions;
}

export interface TaskGraphCanvasSelection {
  readonly nodeKey: string | null;
  readonly edgeId: string | null;
}

export function taskGraphCanvasElements(
  nodes: ReadonlyArray<TaskGraphNode>,
  positions: ReadonlyMap<string, TaskGraphCanvasPoint>,
  selection: TaskGraphCanvasSelection,
): { readonly nodes: TaskGraphCanvasNode[]; readonly edges: TaskGraphCanvasEdge[] } {
  const keys = new Set(nodes.map((node) => node.key));
  return {
    nodes: nodes.map((node) => ({
      id: node.key,
      type: "task",
      position: positions.get(node.key) ?? { x: 0, y: 0 },
      width: TASK_GRAPH_CANVAS_NODE_WIDTH,
      height: TASK_GRAPH_CANVAS_NODE_HEIGHT,
      // Nodes have a fixed size. Declaring it lets xyflow keep handle positions
      // when a status update rebuilds these objects, instead of re-measuring.
      measured: { width: TASK_GRAPH_CANVAS_NODE_WIDTH, height: TASK_GRAPH_CANVAS_NODE_HEIGHT },
      selected: selection.nodeKey === node.key,
      draggable: false,
      data: { node, opensPullRequest: taskGraphNodeOpensPullRequest(nodes, node) },
    })),
    edges: nodes.flatMap((node) =>
      node.dependsOn.flatMap((dependency) => {
        if (!keys.has(dependency)) return [];
        const id = taskGraphCanvasEdgeId(dependency, node.key);
        return [
          {
            id,
            source: dependency,
            target: node.key,
            selected: selection.edgeId === id,
            data: { dependency, dependent: node.key },
          },
        ];
      }),
    ),
  };
}
