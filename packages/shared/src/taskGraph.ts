import {
  MAX_TASK_GRAPH_NODES,
  type TaskGraph,
  type TaskGraphEdit,
  type TaskGraphNode,
  type TaskGraphNodeInput,
  type TaskGraphNodeStatus,
  type TaskGraphStatus,
} from "@t3tools/contracts";

/**
 * Pure task graph rules shared by the server, which owns graphs, and clients,
 * which check an edit before sending it. Nothing here does I/O.
 */

type Nodes = ReadonlyArray<TaskGraphNode>;

export type TaskGraphEditResult =
  | { readonly ok: true; readonly nodes: Nodes }
  | { readonly ok: false; readonly error: string };

const TERMINAL_NODE_STATUSES: ReadonlySet<TaskGraphNodeStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
]);

export const isTerminalTaskGraphNodeStatus = (status: TaskGraphNodeStatus): boolean =>
  TERMINAL_NODE_STATUSES.has(status);

export const isActiveTaskGraphNodeStatus = (status: TaskGraphNodeStatus): boolean =>
  status === "running" || status === "delivering";

/** Not started yet: pending, or waiting for its start time or a reset before its first run. */
export const isUnstartedTaskGraphNode = (node: Pick<TaskGraphNode, "status" | "threadId">) =>
  node.status === "pending" || (node.status === "waiting" && node.threadId === null);

export function newTaskGraphNode(input: TaskGraphNodeInput): TaskGraphNode {
  return {
    key: input.key,
    title: input.title,
    prompt: input.prompt,
    dependsOn: [...new Set(input.dependsOn)],
    pullRequest: input.pullRequest ?? null,
    modelSelection: input.modelSelection ?? null,
    environmentId: input.environmentId ?? null,
    workspace: input.workspace ?? "worktree",
    startAt: input.startAt ?? null,
    waitUntil: null,
    waitReason: null,
    status: "pending",
    assignedEnvironmentId: null,
    threadId: null,
    branch: null,
    worktreePath: null,
    summary: null,
    error: null,
    pullRequestResult: null,
    startedAt: null,
    completedAt: null,
  };
}

/** A reason the nodes do not form a valid graph, or null. */
export function validateTaskGraphNodes(nodes: Nodes): string | null {
  if (nodes.length === 0) return "A task graph needs at least one node.";
  if (nodes.length > MAX_TASK_GRAPH_NODES) {
    return `A task graph holds at most ${MAX_TASK_GRAPH_NODES} nodes.`;
  }
  const keys = new Set<string>();
  for (const node of nodes) {
    if (keys.has(node.key)) return `Node key '${node.key}' is used twice.`;
    keys.add(node.key);
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (dependency === node.key) return `Node '${node.key}' depends on itself.`;
      if (!keys.has(dependency)) {
        return `Node '${node.key}' depends on '${dependency}', which is not in the graph.`;
      }
    }
  }
  const continued = new Set<string>();
  for (const node of nodes) {
    if (node.workspace !== "dependency") continue;
    const [first] = node.dependsOn;
    if (first === undefined) {
      return `Node '${node.key}' continues its dependency's worktree but depends on nothing.`;
    }
    if (nodes.find((other) => other.key === first)?.workspace === "root") {
      return `Node '${node.key}' cannot continue '${first}', which has no worktree.`;
    }
    if (continued.has(first)) {
      return `Only one node can continue in '${first}'s worktree; give the others their own.`;
    }
    continued.add(first);
  }
  const cycle = findCycle(nodes);
  return cycle === null ? null : `Dependencies form a cycle: ${cycle.join(" -> ")}.`;
}

function findCycle(nodes: Nodes): ReadonlyArray<string> | null {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (key: string): ReadonlyArray<string> | null => {
    const seen = state.get(key);
    if (seen === "done") return null;
    if (seen === "visiting") return [...path.slice(path.indexOf(key)), key];
    state.set(key, "visiting");
    path.push(key);
    for (const dependency of byKey.get(key)?.dependsOn ?? []) {
      const cycle = visit(dependency);
      if (cycle !== null) return cycle;
    }
    path.pop();
    state.set(key, "done");
    return null;
  };
  for (const node of nodes) {
    const cycle = visit(node.key);
    if (cycle !== null) return cycle;
  }
  return null;
}

/** Keys of every node below `key`, not including `key`. */
export function taskGraphDescendants(nodes: Nodes, key: string): ReadonlySet<string> {
  const found = new Set<string>();
  const queue = [key];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const node of nodes) {
      if (node.dependsOn.includes(current) && !found.has(node.key)) {
        found.add(node.key);
        queue.push(node.key);
      }
    }
  }
  return found;
}

/** Whether the node opens a pull request when it succeeds. */
export function taskGraphNodeOpensPullRequest(nodes: Nodes, node: TaskGraphNode): boolean {
  if (node.workspace === "root") return false;
  return node.pullRequest ?? !nodes.some((other) => other.dependsOn.includes(node.key));
}

/**
 * The branch a node's pull request targets. Walking up first dependencies past
 * the nodes sharing its branch, the first ancestor with a pull request of its
 * own is the layer below it in a stack; with none, the PR carries everything
 * since the graph's base. So branch ends alone give one PR each against the
 * base, and PRs on inner nodes too give a stack.
 */
export function taskGraphPullRequestBase(
  graph: Pick<TaskGraph, "nodes" | "baseRef">,
  node: TaskGraphNode,
): string {
  const byKey = new Map(graph.nodes.map((candidate) => [candidate.key, candidate]));
  let sharesBranch = node.workspace === "dependency";
  let current = byKey.get(node.dependsOn[0] ?? "");
  const seen = new Set<string>([node.key]);
  while (current !== undefined && !seen.has(current.key)) {
    seen.add(current.key);
    if (
      !sharesBranch &&
      current.branch !== null &&
      taskGraphNodeOpensPullRequest(graph.nodes, current)
    ) {
      return current.branch;
    }
    if (current.workspace === "root") sharesBranch = false;
    else if (sharesBranch) sharesBranch = current.workspace === "dependency";
    current = byKey.get(current.dependsOn[0] ?? "");
  }
  return graph.baseRef;
}

const reopened = (node: TaskGraphNode): TaskGraphNode => ({
  ...node,
  status: "pending",
  waitUntil: null,
  waitReason: null,
  assignedEnvironmentId: null,
  threadId: null,
  branch: null,
  worktreePath: null,
  summary: null,
  error: null,
  pullRequestResult: null,
  startedAt: null,
  completedAt: null,
});

function applyEdit(nodes: Nodes, edit: TaskGraphEdit, now: string): TaskGraphEditResult {
  const target = "key" in edit ? nodes.find((node) => node.key === edit.key) : undefined;
  if (edit.type !== "add_node" && target === undefined) {
    return { ok: false, error: `No node '${edit.key}' in the graph.` };
  }
  switch (edit.type) {
    case "add_node":
      return { ok: true, nodes: [...nodes, newTaskGraphNode(edit.node)] };
    case "update_node": {
      if (!isUnstartedTaskGraphNode(target!)) {
        return { ok: false, error: `Node '${edit.key}' has started and can no longer be edited.` };
      }
      const { type: _type, key: _key, ...fields } = edit;
      const updated: TaskGraphNode = {
        ...target!,
        ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
        ...(fields.dependsOn === undefined ? {} : { dependsOn: [...new Set(fields.dependsOn)] }),
        // An edited node is weighed again from scratch, start time included.
        status: "pending",
        waitUntil: null,
        waitReason: null,
      };
      return { ok: true, nodes: nodes.map((node) => (node.key === edit.key ? updated : node)) };
    }
    case "remove_node":
      if (!isUnstartedTaskGraphNode(target!)) {
        return {
          ok: false,
          error: `Node '${edit.key}' has started. Use cancel_branch to stop it instead.`,
        };
      }
      return {
        ok: true,
        nodes: nodes
          .filter((node) => node.key !== edit.key)
          .map((node) =>
            node.dependsOn.includes(edit.key)
              ? { ...node, dependsOn: node.dependsOn.filter((key) => key !== edit.key) }
              : node,
          ),
      };
    case "cancel_branch": {
      const cut = new Set(taskGraphDescendants(nodes, edit.key));
      cut.add(edit.key);
      return {
        ok: true,
        nodes: nodes.map((node) =>
          cut.has(node.key) && !isTerminalTaskGraphNodeStatus(node.status)
            ? { ...node, status: "cancelled", error: "Cancelled.", completedAt: now }
            : node,
        ),
      };
    }
    case "retry_node": {
      if (target!.status === "succeeded" || !isTerminalTaskGraphNodeStatus(target!.status)) {
        return { ok: false, error: `Node '${edit.key}' has not failed or been cancelled.` };
      }
      const below = taskGraphDescendants(nodes, edit.key);
      return {
        ok: true,
        nodes: nodes.map((node) =>
          node.key === edit.key ||
          (below.has(node.key) && (node.status === "skipped" || node.status === "cancelled"))
            ? reopened(node)
            : node,
        ),
      };
    }
  }
}

/**
 * A failed or cancelled node whose thread started working again, because
 * someone continued it there. The node runs again on the same thread, and what
 * was skipped because of it waits for it again. Null when the node is not one
 * that can resume.
 */
export function resumeTaskGraphNode(nodes: Nodes, key: string): Nodes | null {
  const target = nodes.find((node) => node.key === key);
  if (target === undefined || (target.status !== "failed" && target.status !== "cancelled")) {
    return null;
  }
  const below = taskGraphDescendants(nodes, key);
  return nodes.map((node) =>
    node.key === key
      ? { ...node, status: "running", error: null, pullRequestResult: null, completedAt: null }
      : below.has(node.key) && node.status === "skipped"
        ? reopened(node)
        : node,
  );
}

/** Applies edits in order. Either all apply and the result is a valid graph, or none do. */
export function applyTaskGraphEdits(
  nodes: Nodes,
  edits: ReadonlyArray<TaskGraphEdit>,
  now: string,
): TaskGraphEditResult {
  let current = nodes;
  for (const edit of edits) {
    const result = applyEdit(current, edit, now);
    if (!result.ok) return result;
    current = result.nodes;
  }
  const error = validateTaskGraphNodes(current);
  return error === null ? { ok: true, nodes: current } : { ok: false, error };
}

/**
 * Marks pending nodes whose dependencies can no longer succeed as skipped,
 * repeating until nothing changes so a skip carries all the way down.
 */
export function skipUnreachableTaskGraphNodes(nodes: Nodes, now: string): Nodes {
  let current = nodes;
  for (;;) {
    const status = new Map(current.map((node) => [node.key, node.status]));
    let changed = false;
    current = current.map((node) => {
      if (!isUnstartedTaskGraphNode(node)) return node;
      const blocked = node.dependsOn.find((key) => {
        const dependency = status.get(key);
        return dependency === "failed" || dependency === "cancelled" || dependency === "skipped";
      });
      if (blocked === undefined) return node;
      changed = true;
      return {
        ...node,
        status: "skipped",
        error: `Skipped because '${blocked}' did not succeed.`,
        completedAt: now,
      };
    });
    if (!changed) return current;
  }
}

/**
 * Nodes that could start now: not started, every dependency succeeded, and
 * any wait over. A pending node with a future `startAt` is still returned; the
 * caller moves it to `waiting` until then.
 */
export function readyTaskGraphNodes(nodes: Nodes, now: string): ReadonlyArray<TaskGraphNode> {
  const succeeded = new Set(
    nodes.filter((node) => node.status === "succeeded").map((node) => node.key),
  );
  const nowMs = Date.parse(now);
  return nodes.filter(
    (node) =>
      isUnstartedTaskGraphNode(node) &&
      (node.status === "pending" ||
        node.waitUntil === null ||
        Date.parse(node.waitUntil) <= nowMs) &&
      node.dependsOn.every((key) => succeeded.has(key)),
  );
}

/** The graph status its nodes imply. A draft stays a draft until it is run. */
export function deriveTaskGraphStatus(current: TaskGraphStatus, nodes: Nodes): TaskGraphStatus {
  // Cancelling is final, even with failed nodes, so nothing continued later reopens the graph.
  if (current === "draft" || current === "cancelled") return current;
  if (nodes.some((node) => !isTerminalTaskGraphNodeStatus(node.status))) return "running";
  if (nodes.some((node) => node.status === "failed")) return "failed";
  if (nodes.every((node) => node.status === "succeeded")) return "succeeded";
  return "cancelled";
}

/** Nodes grouped by depth: layer 0 has no dependencies, layer n depends on layer n-1 at most. */
export function taskGraphLayers(nodes: Nodes): ReadonlyArray<ReadonlyArray<TaskGraphNode>> {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const depth = new Map<string, number>();
  const depthOf = (node: TaskGraphNode, guard: number): number => {
    const known = depth.get(node.key);
    if (known !== undefined) return known;
    if (guard > nodes.length) return 0;
    const value = Math.max(
      -1,
      ...node.dependsOn.flatMap((key) => {
        const dependency = byKey.get(key);
        return dependency === undefined ? [] : [depthOf(dependency, guard + 1)];
      }),
    );
    depth.set(node.key, value + 1);
    return value + 1;
  };
  const layers: TaskGraphNode[][] = [];
  for (const node of nodes) {
    const index = depthOf(node, 0);
    (layers[index] ??= []).push(node);
  }
  return layers.filter((layer) => layer !== undefined);
}

const SUMMARY_LIMIT = 4_000;

/** Trims a node's last reply to what its dependents are handed. */
export function taskGraphNodeSummary(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= SUMMARY_LIMIT ? trimmed : `…${trimmed.slice(-SUMMARY_LIMIT)}`;
}

/**
 * The message a node's thread starts with: where it sits in the graph, what
 * its dependencies reported, and which branches to merge before working.
 */
export function buildTaskGraphNodePrompt(
  graph: Pick<TaskGraph, "title" | "nodes">,
  node: TaskGraphNode,
): string {
  const dependencies = node.dependsOn.flatMap((key) => {
    const dependency = graph.nodes.find((candidate) => candidate.key === key);
    return dependency === undefined ? [] : [dependency];
  });
  const sections = [
    `You are running node '${node.key}' of the task graph "${graph.title}". Other agents run the other nodes in their own worktrees.`,
  ];
  const [, ...toMerge] = dependencies;
  // A project-folder node is read-only, so it never merges branches into the shared checkout.
  if (toMerge.length > 0 && node.workspace !== "root") {
    const branches = toMerge.flatMap((dependency) =>
      dependency.branch === null ? [] : [`- ${dependency.branch} (from '${dependency.key}')`],
    );
    if (branches.length > 0) {
      sections.push(
        [
          "Your worktree starts from the first dependency's branch. Before anything else, merge these branches into it with `git merge` (if one is missing locally, `git fetch origin <branch>` and merge `origin/<branch>`), resolve any conflicts so both sides' intent survives, and commit the merge:",
          ...branches,
        ].join("\n"),
      );
    }
  }
  for (const dependency of dependencies) {
    if (dependency.summary === null) continue;
    sections.push(
      `Result of '${dependency.key}' (${dependency.title}):\n<dependency_result>\n${dependency.summary}\n</dependency_result>`,
    );
  }
  if (node.workspace === "dependency" && dependencies[0] !== undefined) {
    sections.push(
      `You continue in '${dependencies[0].key}'s worktree, on its branch; its work is already there. Build on it rather than starting over.`,
    );
  }
  if (node.workspace === "root") {
    sections.push(
      "You work in the project folder itself, shared with other work, not in a worktree of your own. Treat it as read-only: nothing you change is committed, and other agents may be reading it.",
    );
  }
  sections.push(`Your task:\n${node.prompt}`);
  sections.push(
    "Finish with a short summary of what you changed and anything a later step must know. Do not open a pull request yourself; T3 Code handles that when the graph calls for one.",
  );
  return sections.join("\n\n");
}
