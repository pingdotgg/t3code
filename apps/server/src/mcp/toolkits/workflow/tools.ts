import { OrchestratorMcpFailure, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Workflows from "../../../workflows/Workflows.ts";
import { WorkflowRun, WorkflowRunStatus, WorkflowStep } from "../../../workflows/WorkflowStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const WORKFLOW_READ_ACTIONS = ["list", "read", "questions"] as const;

const WorkflowTool = Tool.make("t3_workflow", {
  description:
    "Durable workflow runs on this server. start: `workflow`, `input`, `idempotencyKey` (same key, same run). list: runs, by `status`. read: one run and its steps. questions: what runs ask a person. signal: wake a wait with `value`, addressed by `runId` and `wait`, or by `workflow` and `key`; answers a question as `{choice, reason?}`. resume: run a paused run's failed step again. cancel.",
  parameters: Schema.Struct({
    action: Schema.Literals([...WORKFLOW_READ_ACTIONS, "start", "signal", "resume", "cancel"]),
    workflow: Schema.optional(TrimmedNonEmptyString),
    input: Schema.optional(Schema.Json),
    idempotencyKey: Schema.optional(TrimmedNonEmptyString),
    runId: Schema.optional(TrimmedNonEmptyString),
    status: Schema.optional(WorkflowRunStatus),
    wait: Schema.optional(TrimmedNonEmptyString),
    key: Schema.optional(TrimmedNonEmptyString),
    value: Schema.optional(Schema.Json),
    signalId: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "Reuse it to retry the same signal. A new signal gets a new id.",
      }),
    ),
    reason: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    run: Schema.optional(WorkflowRun),
    steps: Schema.optional(Schema.Array(WorkflowStep)),
    runs: Schema.optional(Schema.Array(WorkflowRun)),
    questions: Schema.optional(Schema.Array(Workflows.WorkflowQuestion)),
    delivery: Schema.optional(Schema.Literals(["delivered", "buffered"])),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    Workflows.Workflows,
    ThreadManagementService.ThreadManagementService,
    SecureRandom.SecureRandom,
  ],
})
  .annotate(Tool.Title, "Workflow runs")
  .annotate(Tool.Destructive, true)
  // Outside clients and the CLI drive workflows. An agent in a thread reaches them through the
  // CLI, so the tool costs no thread any context.
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromThreads);

export const WorkflowToolkit = Toolkit.make(WorkflowTool);
