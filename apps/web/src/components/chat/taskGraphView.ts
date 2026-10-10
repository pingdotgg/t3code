import type {
  TaskGraph,
  TaskGraphNode,
  TaskGraphNodeStatus,
  TaskGraphStatus,
} from "@t3tools/contracts";

/**
 * Presentation helpers shared by the task graph card and its canvas editor.
 * Kept free of canvas imports so the card does not pull the editor's bundle.
 */

export const TASK_GRAPH_STATUS_LABEL: Record<TaskGraphStatus, string> = {
  draft: "Draft",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const TASK_GRAPH_NODE_STATUS_LABEL: Record<TaskGraphNodeStatus, string> = {
  pending: "Pending",
  running: "Running",
  delivering: "Opening PR",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

/** Static status dots: a running node is a solid color, never an animation. */
export const TASK_GRAPH_NODE_STATUS_DOT_CLASS: Record<TaskGraphNodeStatus, string> = {
  pending: "bg-muted-foreground/40",
  running: "bg-sky-500",
  delivering: "bg-sky-500",
  succeeded: "bg-emerald-500",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/70",
  skipped: "bg-muted-foreground/70",
};

export const isTaskGraphFinished = (status: TaskGraphStatus): boolean =>
  status === "succeeded" || status === "failed" || status === "cancelled";

export interface TaskGraphProgress {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly active: number;
}

export function taskGraphProgress(nodes: ReadonlyArray<TaskGraphNode>): TaskGraphProgress {
  let succeeded = 0;
  let failed = 0;
  let active = 0;
  for (const node of nodes) {
    if (node.status === "succeeded") succeeded += 1;
    else if (node.status === "failed") failed += 1;
    else if (node.status === "running" || node.status === "delivering") active += 1;
  }
  return { total: nodes.length, succeeded, failed, active };
}

/** One line for the card header, such as "2 of 5 done · 1 failed". */
export function taskGraphProgressLabel(graph: Pick<TaskGraph, "status" | "nodes">): string {
  const { total, succeeded, failed, active } = taskGraphProgress(graph.nodes);
  if (graph.status === "draft") return `${total} task${total === 1 ? "" : "s"}`;
  const parts = [`${succeeded} of ${total} done`];
  if (active > 0) parts.push(`${active} running`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

/** "#123" for a GitHub, GitLab or Bitbucket pull request URL, otherwise "PR". */
export function pullRequestLabel(url: string): string {
  const number = /\/(?:pull|merge_requests|pull-requests)\/(\d+)/.exec(url)?.[1];
  return number === undefined ? "PR" : `#${number}`;
}

export interface TaskGraphPullRequestLink {
  readonly key: string;
  readonly title: string;
  readonly url: string;
  readonly label: string;
}

export function taskGraphPullRequestLinks(
  nodes: ReadonlyArray<TaskGraphNode>,
): ReadonlyArray<TaskGraphPullRequestLink> {
  return nodes.flatMap((node) => {
    const url = node.pullRequestResult?.url;
    return url ? [{ key: node.key, title: node.title, url, label: pullRequestLabel(url) }] : [];
  });
}

const KEY_MAX_LENGTH = 48;

/**
 * A node key derived from a title that matches `TaskGraphNodeKey` and is not
 * already taken, such as "Audit auth" -> "audit-auth" or "audit-auth-2".
 */
export function taskGraphNodeKeyFromTitle(title: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    title
      .normalize("NFKD")
      .replace(/\p{Mn}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, KEY_MAX_LENGTH)
      .replace(/-+$/, "") || "task";
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${base.slice(0, KEY_MAX_LENGTH - tail.length).replace(/-+$/, "")}${tail}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Box size and spacing of the inline diagram, in CSS pixels. */
export const TASK_GRAPH_DIAGRAM = {
  nodeWidth: 168,
  nodeHeight: 40,
  columnGap: 40,
  rowGap: 10,
} as const;

export interface TaskGraphDiagramLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: ReadonlyArray<{
    readonly node: TaskGraphNode;
    readonly x: number;
    readonly y: number;
  }>;
  readonly edges: ReadonlyArray<{ readonly key: string; readonly path: string }>;
}

/**
 * Lays a graph out left to right for the inline card: one column per
 * dependency depth, each column centred on the tallest, and a curve from the
 * right edge of every dependency to the left edge of the node that waits on it.
 * Plain arithmetic, so the card never loads the editor's layout library.
 */
export function taskGraphDiagramLayout(
  layers: ReadonlyArray<ReadonlyArray<TaskGraphNode>>,
): TaskGraphDiagramLayout {
  const { nodeWidth, nodeHeight, columnGap, rowGap } = TASK_GRAPH_DIAGRAM;
  const columnHeight = (count: number) => count * nodeHeight + Math.max(0, count - 1) * rowGap;
  const height = Math.max(0, ...layers.map((layer) => columnHeight(layer.length)));
  const width = Math.max(0, layers.length * nodeWidth + (layers.length - 1) * columnGap);
  const positions = new Map<string, { x: number; y: number }>();
  const nodes = layers.flatMap((layer, column) => {
    const top = (height - columnHeight(layer.length)) / 2;
    return layer.map((node, row) => {
      const position = {
        x: column * (nodeWidth + columnGap),
        y: top + row * (nodeHeight + rowGap),
      };
      positions.set(node.key, position);
      return { node, ...position };
    });
  });
  const edges = nodes.flatMap(({ node, x, y }) =>
    node.dependsOn.flatMap((dependencyKey) => {
      const from = positions.get(dependencyKey);
      if (from === undefined) return [];
      const startX = from.x + nodeWidth;
      const startY = from.y + nodeHeight / 2;
      const endY = y + nodeHeight / 2;
      const middleX = (startX + x) / 2;
      return [
        {
          key: `${dependencyKey}->${node.key}`,
          path: `M ${startX} ${startY} C ${middleX} ${startY}, ${middleX} ${endY}, ${x} ${endY}`,
        },
      ];
    }),
  );
  return { width, height, nodes, edges };
}
