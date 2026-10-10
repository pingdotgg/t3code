import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  TaskGraphId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/** Most nodes one graph may hold. A graph is a plan for a turn, not a backlog. */
export const MAX_TASK_GRAPH_NODES = 48;

/** A node's key within its graph, chosen by whoever writes the graph, such as `audit-auth`. */
export const TaskGraphNodeKey = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,47}$/),
).annotate({
  description: "Lowercase letters, digits and dashes, up to 48 characters, such as 'audit-auth'.",
});
export type TaskGraphNodeKey = typeof TaskGraphNodeKey.Type;

/**
 * - `pending`: waiting for its dependencies, or for the graph to run.
 * - `running`: its thread has a turn in progress.
 * - `waiting`: held until `waitUntil`: a scheduled start, or a usage limit reset. A node
 *   with a thread was stopped by the limit and continues on that thread at the reset.
 * - `delivering`: the turn finished and the branch is being committed, pushed and opened as a PR.
 * - `skipped`: a dependency failed or was cancelled, so it never started.
 */
export const TaskGraphNodeStatus = Schema.Literals([
  "pending",
  "waiting",
  "running",
  "delivering",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
]);
export type TaskGraphNodeStatus = typeof TaskGraphNodeStatus.Type;

export const TaskGraphStatus = Schema.Literals([
  "draft",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type TaskGraphStatus = typeof TaskGraphStatus.Type;

const nodeFields = {
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  dependsOn: Schema.Array(TaskGraphNodeKey).annotate({
    description:
      "Keys of nodes that must succeed first. A node with several dependencies starts from the first one's branch and merges the others in.",
  }),
};

/**
 * Where a node works:
 * - `worktree`: its own new worktree and branch.
 * - `dependency`: continues in its first dependency's worktree and branch, so
 *   several nodes can build one branch in turn. Runs on that node's machine.
 * - `root`: the project folder itself, with no branch, commit or pull request.
 *   For read-only work such as reviews.
 */
export const TaskGraphNodeWorkspace = Schema.Literals(["worktree", "dependency", "root"]);
export type TaskGraphNodeWorkspace = typeof TaskGraphNodeWorkspace.Type;

export const TaskGraphNodeWaitReason = Schema.Literals(["scheduled", "usage_limit"]);
export type TaskGraphNodeWaitReason = typeof TaskGraphNodeWaitReason.Type;

export const TaskGraphNodeInput = Schema.Struct({
  key: TaskGraphNodeKey,
  ...nodeFields,
  pullRequest: Schema.optional(Schema.Boolean).annotate({
    description:
      "Commit, push and open a pull request for this node's branch when it succeeds. Defaults to true for nodes nothing depends on.",
  }),
  modelSelection: Schema.optional(ModelSelection).annotate({
    description: "Provider and model for this node. Defaults to the graph's thread.",
  }),
  environmentId: Schema.optional(Schema.NullOr(EnvironmentId)).annotate({
    description:
      "Machine to run on, from task_graph_list's machines. Null or omitted balances across this machine and its paired peers.",
  }),
  startAt: Schema.optional(Schema.NullOr(IsoDateTime)).annotate({
    description:
      "Earliest time the node may start, as an ISO timestamp such as 2026-10-11T02:00:00Z. Omit to start as soon as its dependencies succeed.",
  }),
  workspace: Schema.optional(TaskGraphNodeWorkspace).annotate({
    description:
      "'worktree' (default): its own new worktree and branch. 'dependency': continue in the first dependency's worktree and branch, so one branch is built by several nodes in turn. 'root': the project folder, no branch, commit or PR; for read-only work such as reviews.",
  }),
});
export type TaskGraphNodeInput = typeof TaskGraphNodeInput.Type;

export const TaskGraphNodePullRequest = Schema.Struct({
  status: Schema.Literals(["opened", "failed"]),
  url: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type TaskGraphNodePullRequest = typeof TaskGraphNodePullRequest.Type;

export const TaskGraphNode = Schema.Struct({
  key: TaskGraphNodeKey,
  ...nodeFields,
  /** Null opens a pull request only when no other node depends on this one. */
  pullRequest: Schema.NullOr(Schema.Boolean),
  modelSelection: Schema.NullOr(ModelSelection),
  environmentId: Schema.NullOr(EnvironmentId),
  workspace: TaskGraphNodeWorkspace.pipe(
    Schema.withDecodingDefault(Effect.succeed("worktree" as const)),
  ),
  /** Earliest start; null starts once dependencies succeed. */
  startAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  status: TaskGraphNodeStatus,
  /** While `waiting`: when the wait ends, and why. */
  waitUntil: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  waitReason: Schema.NullOr(TaskGraphNodeWaitReason).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Where the node ran or runs; null until it starts. */
  assignedEnvironmentId: Schema.NullOr(EnvironmentId),
  threadId: Schema.NullOr(ThreadId),
  branch: Schema.NullOr(Schema.String),
  /** Where the node worked on its machine; a `dependency` node continues there. */
  worktreePath: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The end of the node's last reply, handed to the nodes that depend on it. */
  summary: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  pullRequestResult: Schema.NullOr(TaskGraphNodePullRequest),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type TaskGraphNode = typeof TaskGraphNode.Type;

export const TaskGraph = Schema.Struct({
  id: TaskGraphId,
  projectId: ProjectId,
  /** The thread that proposed the graph; it hears back when the graph ends. */
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  /** Ref that nodes without dependencies branch from. */
  baseRef: TrimmedNonEmptyString,
  /** The proposing thread's model when the graph was made; nodes without their own use it. */
  modelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  status: TaskGraphStatus,
  nodes: Schema.Array(TaskGraphNode),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TaskGraph = typeof TaskGraph.Type;

/**
 * One change to a graph. Agents send these through MCP and the editor sends
 * them over RPC, so both see the same rules. Only pending nodes can be edited
 * or removed; `cancel_branch` cuts a node and everything below it, running or
 * not, and `retry_node` reopens a node that did not succeed.
 */
export const TaskGraphEdit = Schema.Union([
  Schema.Struct({ type: Schema.Literal("add_node"), node: TaskGraphNodeInput }),
  Schema.Struct({
    type: Schema.Literal("update_node"),
    key: TaskGraphNodeKey,
    title: Schema.optional(nodeFields.title),
    prompt: Schema.optional(nodeFields.prompt),
    dependsOn: Schema.optional(nodeFields.dependsOn),
    pullRequest: Schema.optional(Schema.NullOr(Schema.Boolean)),
    modelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
    environmentId: Schema.optional(Schema.NullOr(EnvironmentId)),
    workspace: Schema.optional(TaskGraphNodeWorkspace),
    startAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  }),
  Schema.Struct({ type: Schema.Literal("remove_node"), key: TaskGraphNodeKey }),
  Schema.Struct({ type: Schema.Literal("cancel_branch"), key: TaskGraphNodeKey }),
  Schema.Struct({ type: Schema.Literal("retry_node"), key: TaskGraphNodeKey }),
]).annotate({
  description:
    "Pass an object with type add_node, update_node, remove_node, cancel_branch or retry_node.",
});
export type TaskGraphEdit = typeof TaskGraphEdit.Type;

export const TaskGraphCreateInput = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  nodes: Schema.Array(TaskGraphNodeInput).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_TASK_GRAPH_NODES),
  ),
  baseRef: Schema.optional(TrimmedNonEmptyString),
  /** Run at once, or leave a draft. Omit to follow the environment's `taskGraphAutoRun`. */
  run: Schema.optional(Schema.Boolean),
});
export type TaskGraphCreateInput = typeof TaskGraphCreateInput.Type;

export const TaskGraphSubscribeInput = Schema.Struct({ threadId: ThreadId });
export type TaskGraphSubscribeInput = typeof TaskGraphSubscribeInput.Type;

export const TaskGraphListResult = Schema.Struct({ graphs: Schema.Array(TaskGraph) });
export type TaskGraphListResult = typeof TaskGraphListResult.Type;

export const TaskGraphEditInput = Schema.Struct({
  graphId: TaskGraphId,
  edits: Schema.Array(TaskGraphEdit).check(Schema.isMinLength(1)),
});
export type TaskGraphEditInput = typeof TaskGraphEditInput.Type;

export const TaskGraphTargetInput = Schema.Struct({ graphId: TaskGraphId });
export type TaskGraphTargetInput = typeof TaskGraphTargetInput.Type;

export const TaskGraphResult = Schema.Struct({ graph: TaskGraph });
export type TaskGraphResult = typeof TaskGraphResult.Type;

export class TaskGraphError extends Schema.TaggedError<TaskGraphError>()("TaskGraphError", {
  message: Schema.String,
  graphId: Schema.optional(TaskGraphId),
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * Another T3 Code environment this one may run task graph nodes on. This
 * server holds a narrowly scoped session on the peer: it can start, watch and
 * stop threads and push their branches, nothing else.
 */
export const TaskGraphPeer = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  httpBaseUrl: TrimmedNonEmptyString,
  /** 0 never places nodes there automatically; same scale as client load balancing. */
  weight: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  status: Schema.Literals(["connecting", "connected", "unreachable", "unauthorized"]),
  error: Schema.NullOr(Schema.String),
  addedAt: IsoDateTime,
});
export type TaskGraphPeer = typeof TaskGraphPeer.Type;

export const TaskGraphPeerListResult = Schema.Struct({ peers: Schema.Array(TaskGraphPeer) });
export type TaskGraphPeerListResult = typeof TaskGraphPeerListResult.Type;

export const TaskGraphPeerAddInput = Schema.Struct({
  /** A pairing link from the peer, such as https://host/pair#token=ABCD. */
  pairingUrl: TrimmedNonEmptyString,
  label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
});
export type TaskGraphPeerAddInput = typeof TaskGraphPeerAddInput.Type;

export const TaskGraphPeerTargetInput = Schema.Struct({ environmentId: EnvironmentId });
export type TaskGraphPeerTargetInput = typeof TaskGraphPeerTargetInput.Type;

export const TaskGraphPeerSetWeightInput = Schema.Struct({
  environmentId: EnvironmentId,
  weight: TaskGraphPeer.fields.weight,
});
export type TaskGraphPeerSetWeightInput = typeof TaskGraphPeerSetWeightInput.Type;
