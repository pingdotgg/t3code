import {
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
import * as TaskGraphService from "../../../taskGraph/TaskGraphService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  TaskGraphService.TaskGraphService,
];

const GraphResult = Schema.Struct({ graph: TaskGraph });
const GraphTarget = Schema.Struct({ graphId: TaskGraphId });

export const TaskGraphCreateTool = Tool.make("task_graph_create", {
  description:
    "Needs an agent running inside a T3 thread. Plan work as a graph of agent tasks and run it. Each node runs as its own T3 thread in its own git worktree, in parallel where dependencies allow. A node with no dependencies branches from baseRef (default: this thread's branch); a node with one dependency branches from that dependency's branch; a node with several starts from the first one's branch and merges the others before its task, and receives every dependency's final summary. When a node succeeds its work is committed; nodes nothing depends on also push and open a pull request (override per node with pullRequest), so each branch end of the tree becomes one PR. When the whole graph ends, this thread gets a report message. Use it when a request splits into independent pieces (audits of separate areas, features with sub-parts, a merge step that combines them). Write each prompt so an agent with no access to this conversation can do it. RUNNING: if the user asked to see, review or edit the plan first, pass run=false so it waits as a draft they can edit in the chat; if they asked to just do it, pass run=true; otherwise omit run to follow their setting. Change a graph later with task_graph_edit.",
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
    "Needs an agent running inside a T3 thread. List the task graphs this thread created, with every node's status, thread, branch, summary and pull request.",
  success: Schema.Struct({ graphs: Schema.Array(TaskGraph) }),
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
