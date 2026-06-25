import {
  CollectDelegatedTasksRequest,
  DelegateTasksRequest,
  DelegateTasksResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { TaskOrchestrator } from "../../../orchestration/Services/TaskOrchestrator.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, TaskOrchestrator];

/** Returned only when the call is refused (e.g. a child trying to delegate). */
export const DelegateTasksFailure = Schema.Struct({
  reason: Schema.String,
});

export const DelegateTasksTool = Tool.make("delegate_tasks", {
  description:
    "Delegate sub-tasks to fresh child agents that run in parallel. Returns quickly: each result is " +
    "either finished ('completed'/'error') or still 'running' (with its `threadId`). For any result " +
    "with status 'running', call `collect_delegated_tasks` afterwards to get its final message — do not " +
    "assume a 'running' task failed. " +
    "WHEN TO USE — proactively, without being asked: whenever a request breaks into 2+ parts that do " +
    "not depend on each other's output (research several files at once, answer multiple questions, " +
    "review/summarize different modules, independent edits). Skip it for a single linear task or when " +
    "one step's result feeds the next. " +
    "CHOOSING THE MODEL per sub-task — set `modelHint`: 'cheap' for trivial/mechanical lookups (list " +
    "files, grep, count, simple summaries), 'balanced' for normal work (default when unsure), 'strong' " +
    "for hard reasoning, code review, or tricky debugging. For planning or design sub-tasks, put the word " +
    '"plan" in the `label` so they route to the strongest model. Pass `modelSelection` instead only when ' +
    "the user named a specific model. " +
    "Always give each sub-task a short descriptive `label`. Sub-tasks share this thread's working " +
    "directory and run concurrently, so keep their file changes non-overlapping to avoid conflicts.",
  parameters: DelegateTasksRequest,
  success: DelegateTasksResult,
  failure: DelegateTasksFailure,
  dependencies,
})
  .annotate(Tool.Title, "Delegate sub-tasks")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const CollectDelegatedTasksTool = Tool.make("collect_delegated_tasks", {
  description:
    "Collect results for sub-tasks that were still 'running' when `delegate_tasks` (or a prior " +
    "`collect_delegated_tasks`) returned. Pass the `threadIds` of the running sub-tasks, or omit them to " +
    "collect every still-running sub-task you delegated from this thread. Returns quickly; any task still " +
    "not finished comes back as 'running' again — keep calling until none remain 'running'.",
  parameters: CollectDelegatedTasksRequest,
  success: DelegateTasksResult,
  dependencies,
})
  .annotate(Tool.Title, "Collect delegated sub-tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const DelegationToolkit = Toolkit.make(DelegateTasksTool, CollectDelegatedTasksTool);
