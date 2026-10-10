import type {
  EnvironmentId,
  ModelSelection,
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
  waiting: "Waiting",
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
  waiting: "bg-warning",
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
  readonly waiting: number;
}

export function taskGraphProgress(nodes: ReadonlyArray<TaskGraphNode>): TaskGraphProgress {
  let succeeded = 0;
  let failed = 0;
  let active = 0;
  let waiting = 0;
  for (const node of nodes) {
    if (node.status === "succeeded") succeeded += 1;
    else if (node.status === "failed") failed += 1;
    else if (node.status === "running" || node.status === "delivering") active += 1;
    else if (node.status === "waiting") waiting += 1;
  }
  return { total: nodes.length, succeeded, failed, active, waiting };
}

/** One line for the card header, such as "2 of 5 done · 1 waiting · 1 failed". */
export function taskGraphProgressLabel(graph: Pick<TaskGraph, "status" | "nodes">): string {
  const { total, succeeded, failed, active, waiting } = taskGraphProgress(graph.nodes);
  if (graph.status === "draft") return `${total} task${total === 1 ? "" : "s"}`;
  const parts = [`${succeeded} of ${total} done`];
  if (active > 0) parts.push(`${active} running`);
  if (waiting > 0) parts.push(`${waiting} waiting`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

/**
 * A node's status in a few words, naming when a wait ends, such as
 * "Usage limit · resets 3:40 PM". `formatTime` renders an upcoming instant.
 */
export function taskGraphNodeStatusText(
  node: Pick<TaskGraphNode, "status" | "waitUntil" | "waitReason">,
  formatTime: (iso: string) => string,
): string {
  if (node.status !== "waiting" || node.waitUntil === null) {
    return TASK_GRAPH_NODE_STATUS_LABEL[node.status];
  }
  const at = formatTime(node.waitUntil);
  return node.waitReason === "usage_limit" ? `Usage limit · resets ${at}` : `Waiting · until ${at}`;
}

/** Why a waiting node waits and what happens next, for its details. Null when it is not waiting. */
export function taskGraphNodeWaitDetail(
  node: Pick<TaskGraphNode, "status" | "waitUntil" | "waitReason" | "threadId">,
  formatTime: (iso: string) => string,
): string | null {
  if (node.status !== "waiting") return null;
  const at = node.waitUntil === null ? null : formatTime(node.waitUntil);
  if (node.waitReason === "usage_limit") {
    const next =
      node.threadId === null ? "starts after the reset" : "continues on its thread after the reset";
    return `Usage limit reached — ${next}${at === null ? "" : `, ${at}`}`;
  }
  return at === null ? "Waiting to start" : `Starts ${at}`;
}

/** The model a node runs with: its own, else the graph's. Null when neither is known. */
export const taskGraphNodeModel = (
  graph: Pick<TaskGraph, "modelSelection">,
  node: Pick<TaskGraphNode, "modelSelection">,
): ModelSelection | null => node.modelSelection ?? graph.modelSelection;

/**
 * The machine a node runs or will run on, the way the server places it: where
 * it started, else its first dependency's machine when it continues that
 * worktree, else where it is pinned. Null means it will be balanced automatically.
 */
export function taskGraphNodeMachine(
  nodes: ReadonlyArray<TaskGraphNode>,
  node: TaskGraphNode,
): EnvironmentId | null {
  let current = node;
  // Bounded by the node count, so a malformed cycle cannot loop forever.
  for (let hops = 0; hops <= nodes.length; hops += 1) {
    if (current.assignedEnvironmentId !== null) return current.assignedEnvironmentId;
    if (current.workspace !== "dependency") return current.environmentId;
    const dependency = nodes.find((candidate) => candidate.key === current.dependsOn[0]);
    if (dependency === undefined) return current.environmentId;
    current = dependency;
  }
  return null;
}

/**
 * Whether a new or edited task may continue `dependency`'s worktree: the
 * dependency has one, and no other task already continues it.
 */
export function canContinueTaskGraphWorktree(
  nodes: ReadonlyArray<TaskGraphNode>,
  dependency: TaskGraphNode,
  exceptKey: string | null = null,
): boolean {
  return (
    dependency.workspace !== "root" &&
    !nodes.some(
      (other) =>
        other.key !== exceptKey &&
        other.workspace === "dependency" &&
        other.dependsOn[0] === dependency.key,
    )
  );
}

export interface TaskGraphJoinMachine {
  readonly dependency: TaskGraphNode;
  readonly machine: EnvironmentId;
  /** False when that dependency's worktree cannot be continued. */
  readonly available: boolean;
}

/**
 * For a task that joins branches known to be on different machines, the
 * machines it could bring them together on, each by continuing that
 * dependency's worktree there. Null when there is nothing to reconcile: fewer
 * than two dependencies, or no two on known, different machines.
 */
export function taskGraphJoinMachines(
  nodes: ReadonlyArray<TaskGraphNode>,
  node: TaskGraphNode,
): ReadonlyArray<TaskGraphJoinMachine> | null {
  const placed = node.dependsOn.flatMap((key) => {
    const dependency = nodes.find((candidate) => candidate.key === key);
    const machine = dependency === undefined ? null : taskGraphNodeMachine(nodes, dependency);
    return dependency === undefined || machine === null ? [] : [{ dependency, machine }];
  });
  if (new Set(placed.map((entry) => entry.machine)).size < 2) return null;
  return placed.map((entry) => ({
    ...entry,
    available: canContinueTaskGraphWorktree(nodes, entry.dependency, node.key),
  }));
}

/**
 * The models and machines a graph spreads over, for the card header, such as
 * "Claude Opus 5.5 · GPT-5 +1 · 2 machines". Machines count only where nodes
 * started or are pinned; with none of either the graph is "auto-balanced".
 */
export function taskGraphResourcesLabel(
  graph: Pick<TaskGraph, "modelSelection" | "nodes">,
  modelLabel: (selection: ModelSelection) => string,
): string {
  const models = new Set<string>();
  const machines = new Set<EnvironmentId>();
  for (const node of graph.nodes) {
    const model = taskGraphNodeModel(graph, node);
    if (model !== null) models.add(modelLabel(model));
    const machine = taskGraphNodeMachine(graph.nodes, node);
    if (machine !== null) machines.add(machine);
  }
  const labels = [...models];
  const parts = labels.slice(0, 2);
  if (labels.length > 2) parts[1] = `${parts[1]} +${labels.length - 2}`;
  parts.push(
    machines.size === 0
      ? "auto-balanced"
      : `${machines.size} machine${machines.size === 1 ? "" : "s"}`,
  );
  return parts.join(" · ");
}

/** Where a node works, in words, such as "Continues Audit auth's worktree". */
export function taskGraphWorkspaceLabel(
  node: TaskGraphNode,
  titleOf: (key: string) => string,
): string {
  if (node.workspace === "root") return "Project folder, no branch";
  const dependency = node.dependsOn[0];
  if (node.workspace === "dependency" && dependency !== undefined) {
    return `Continues ${titleOf(dependency)}'s worktree`;
  }
  return "New worktree";
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
  nodeWidth: 188,
  nodeHeight: 58,
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
