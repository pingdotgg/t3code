import {
  ModelSelection,
  ProviderOptionDescriptor,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  OperatorError,
  OperatorService,
  type OperatorModelInventory,
  type OperatorSpawnResult,
  type OperatorTaskStatus,
} from "../../../operator/OperatorService.ts";

const OperatorTaskStatusSchema: Schema.Schema<OperatorTaskStatus> = Schema.Struct({
  taskId: ThreadId,
  batchId: Schema.NullOr(Schema.String),
  title: Schema.String,
  modelSelection: ModelSelection,
  status: Schema.Literals(["queued", "running", "waiting", "completed", "failed", "stopped"]),
  startedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});

const OperatorModelInventorySchema: Schema.Schema<OperatorModelInventory> = Schema.Struct({
  instanceId: Schema.String,
  driver: Schema.String,
  displayName: Schema.String,
  available: Schema.Boolean,
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.String,
      name: Schema.String,
      capabilities: Schema.NullOr(
        Schema.Struct({
          optionDescriptors: Schema.optional(Schema.Array(ProviderOptionDescriptor)),
        }),
      ),
    }),
  ),
});

const TaskIdsInput = Schema.Struct({
  taskIds: Schema.optional(Schema.Array(ThreadId).check(Schema.isMaxLength(16))),
});

const NoParameters = Schema.Record(Schema.String, Schema.Never);

const dependencies = [McpInvocationContext.McpInvocationContext, OperatorService];

export const OperatorModelsTool = Tool.make("operator_models", {
  description:
    "List the exact provider instances, model slugs, and option values available to Agentic Operator. Operator creates top-level T3 Code sidebar tasks, never native provider subagents. Call this before spawning and never substitute an unavailable provider, model, or option.",
  parameters: NoParameters,
  success: Schema.Struct({ providers: Schema.Array(OperatorModelInventorySchema) }),
  failure: OperatorError,
  dependencies,
})
  .annotate(Tool.Title, "List Operator models")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const OperatorSpawnTool = Tool.make("operator_spawn", {
  description:
    "Create one or more durable, top-level T3 Code sidebar task threads with the exact provider, model, and options supplied. These are independent T3 Code tasks, not native provider subagents. Parallel tasks share one checkout, so give them disjoint file ownership. Omit workspaceMode or use 'current' to use the coordinator checkout without asking the user. Use 'new-worktree' with branch and baseBranch only when the user explicitly requests a new worktree. After that, use 'operator' to reuse the remembered Operator worktree. Returns immediately. Call operator_wait once for the returned task IDs whose status is not failed, then use their results to prompt an integration task if needed. Never use this unless the user explicitly requested Agentic Operator.",
  parameters: Schema.Struct({
    tasks: Schema.Array(
      Schema.Struct({
        title: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
        prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
        modelSelection: ModelSelection,
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
    workspaceMode: Schema.optional(Schema.Literals(["operator", "current", "new-worktree"])),
    branch: Schema.optional(TrimmedNonEmptyString),
    baseBranch: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({
    batchId: Schema.String,
    workspacePath: Schema.String,
    branch: Schema.NullOr(Schema.String),
    tasks: Schema.Array(OperatorTaskStatusSchema),
  }) as Schema.Schema<OperatorSpawnResult>,
  failure: OperatorError,
  dependencies,
})
  .annotate(Tool.Title, "Spawn Operator tasks")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

export const OperatorResumeTool = Tool.make("operator_resume", {
  description:
    "Start a new turn on one or more previously spawned Operator task threads, preserving each task's provider, model, checkout, branch, and conversation history. Supply a separate instruction for every task. Only completed, failed, or stopped tasks can be resumed. This resumes the existing durable T3 Code tasks and never creates replacements or native provider subagents. Call operator_wait once for the returned task IDs whose status is not failed.",
  parameters: Schema.Struct({
    tasks: Schema.Array(
      Schema.Struct({
        taskId: ThreadId,
        prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  }),
  success: Schema.Struct({ tasks: Schema.Array(OperatorTaskStatusSchema) }) as Schema.Schema<{
    readonly tasks: ReadonlyArray<OperatorTaskStatus>;
  }>,
  failure: OperatorError,
  dependencies,
})
  .annotate(Tool.Title, "Resume Operator tasks")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

export const OperatorStatusTool = Tool.make("operator_status", {
  description:
    "Read current status and available final output for this coordinator's top-level Operator sidebar tasks. Omit taskIds to list every task. Prefer operator_wait when work is still running instead of polling this tool.",
  parameters: TaskIdsInput,
  success: Schema.Struct({ tasks: Schema.Array(OperatorTaskStatusSchema) }),
  failure: OperatorError,
  dependencies,
})
  .annotate(Tool.Title, "Get Operator status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const OperatorWaitTool = Tool.make("operator_wait", {
  description:
    "Wait without model polling until all selected Operator tasks finish, fail, stop, or need user input. Returns each task's final assistant output. Call once after operator_spawn; do not repeatedly call operator_status while work runs.",
  parameters: TaskIdsInput,
  success: Schema.Struct({ tasks: Schema.Array(OperatorTaskStatusSchema) }),
  failure: OperatorError,
  dependencies,
})
  .annotate(Tool.Title, "Wait for Operator tasks")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const OperatorToolkit = Toolkit.make(
  OperatorModelsTool,
  OperatorSpawnTool,
  OperatorResumeTool,
  OperatorStatusTool,
  OperatorWaitTool,
);
