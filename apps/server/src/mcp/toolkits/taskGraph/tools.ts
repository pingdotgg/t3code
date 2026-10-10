import {
  EnvironmentId,
  MAX_TASK_GRAPH_NODES,
  OrchestratorMcpFailure,
  TaskGraph,
  TaskGraphEdit,
  TaskGraphId,
  TaskGraphNodeInput,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as TaskGraphPeers from "../../../taskGraph/TaskGraphPeers.ts";
import * as TaskGraphService from "../../../taskGraph/TaskGraphService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  TaskGraphService.TaskGraphService,
  TaskGraphPeers.TaskGraphPeers,
  ServerEnvironment.ServerEnvironment,
];

const GraphResult = Schema.Struct({ graph: TaskGraph });
const GraphTarget = Schema.Struct({ graphId: TaskGraphId });

export const TaskGraphCreateTool = Tool.make("task_graph_create", {
  description:
    "Needs an agent running inside a T3 thread. Plan work as a graph of agent tasks and run it. Each node runs as its own T3 thread, in parallel where dependencies allow, and receives every dependency's final summary. Write each prompt so an agent with no access to this conversation can do it. " +
    "WORKSPACES: by default a node gets its own git worktree, branching from its first dependency's branch (or baseRef, default this thread's branch). workspace 'dependency' continues in the first dependency's worktree and branch instead, so several nodes build one branch in turn. workspace 'root' works in the project folder with no branch, commit or PR; use it for read-only work such as reviews and audits. " +
    "PULL REQUESTS: a succeeding node's work is committed. Nodes nothing depends on also push and open a PR; set pullRequest per node to change that. A PR targets the nearest earlier node (following first dependencies) that has its own PR, else the graph base, so PRs only on branch ends give one PR each against the base, and PRs on inner nodes too give a stack. " +
    "STACKED PRS: when the user asks for stacked PRs, do not do the work yourself one layer after another. Make each layer a node (or a short 'dependency' chain) with pullRequest true, each depending on the layer below, and put independent work for a layer in its own subtree that merges back before the next layer. One graph then produces the whole stack. " +
    "MERGING: a node with several dependencies starts from the first one's branch and merges the others, resolving conflicts. Only add such a combining node when the user asks for the pieces to be reconciled or they cannot work apart; otherwise leave the branches independent, each ending in its own PR. " +
    "MACHINES: set environmentId on a node to pin it to a machine listed by task_graph_list (only when the user asks); otherwise omit it and nodes are balanced across machines by load. A 'dependency' node always runs where its dependency ran. Set modelSelection on a node only when the user asks for a different model. " +
    "TIMING: set startAt on a node to hold it until a time the user asks for, such as overnight. A node never starts into a used-up usage limit: it waits for the reset. A node whose run is stopped by a usage limit waits too, and continues on its own thread at the reset, so do not retry or replace it. " +
    "RUNNING: if the user asked to see, review or edit the plan first, pass run=false so it waits as a draft they can edit in the chat; if they asked to just do it, pass run=true; otherwise omit run to follow their setting. Change a graph later with task_graph_edit.",
  parameters: Schema.Struct({
    title: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
    nodes: Schema.Array(TaskGraphNodeInput).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_TASK_GRAPH_NODES),
    ),
    baseRef: Schema.optional(TrimmedNonEmptyString),
    run: Schema.optional(Schema.Boolean),
  }),
  success: GraphResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create a task graph")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const TaskGraphListTool = Tool.make("task_graph_list", {
  description:
    "Needs an agent running inside a T3 thread. List the task graphs this thread created, with every node's status, thread, machine, branch, summary and pull request, and the machines nodes can run on (pass one's environmentId to pin a node there).",
  success: Schema.Struct({
    graphs: Schema.Array(TaskGraph),
    machines: Schema.Array(
      Schema.Struct({
        environmentId: EnvironmentId,
        label: Schema.String,
        thisMachine: Schema.Boolean,
        connected: Schema.Boolean,
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List task graphs")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const TaskGraphEditTool = Tool.make("task_graph_edit", {
  description:
    "Change a task graph from this thread, running or not. Edits apply in order and all or nothing. add_node adds work (it starts as soon as its dependencies succeeded); update_node and remove_node change nodes that have not started; cancel_branch cuts a node and everything below it, stopping any that are running; retry_node reruns a node that failed or was cancelled, along with what was skipped below it.",
  parameters: Schema.Struct({
    graphId: TaskGraphId,
    edits: Schema.Array(TaskGraphEdit).check(Schema.isMinLength(1)),
  }),
  success: GraphResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Edit a task graph")
  .annotate(Tool.Destructive, true);

const TaskGraphRunTool = Tool.make("task_graph_run", {
  description:
    "Start a draft task graph from this thread. Only call this when the user asks to run it.",
  parameters: GraphTarget,
  success: GraphResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Run a task graph")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const TaskGraphCancelTool = Tool.make("task_graph_cancel", {
  description:
    "Cancel a whole task graph from this thread, stopping every running node. Finished nodes and their pull requests stay.",
  parameters: GraphTarget,
  success: GraphResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cancel a task graph")
  .annotate(Tool.Destructive, true);

export const TaskGraphToolkit = Toolkit.make(
  TaskGraphCreateTool,
  TaskGraphListTool,
  TaskGraphEditTool,
  TaskGraphRunTool,
  TaskGraphCancelTool,
);
