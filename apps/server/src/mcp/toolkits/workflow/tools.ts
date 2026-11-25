import { OrchestratorMcpFailure, TrimmedNonEmptyString, WorkflowHook } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Workflows from "../../../workflows/Workflows.ts";
import { WorkflowRun, WorkflowRunStatus, WorkflowStep } from "../../../workflows/WorkflowStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const WORKFLOW_READ_ACTIONS = ["list", "read", "questions", "store"] as const;

// Wait names, store keys and channels match exactly, so they keep their spaces.
const ExactName = Schema.String.check(
  Schema.makeFilter((name: string) => name.trim().length > 0, { expected: "a non-blank string" }),
);

const WorkflowTool = Tool.make("t3_workflow", {
  description:
    "Durable workflow runs on this server. start: `workflow`, `input`, `idempotencyKey` (same key, same run). list: runs, by `status` and `tag`. read: one run and its steps. questions: what runs ask a person, by `kind`. hooks: the URL paths that start runs. store: what workflows keep, under keys starting with `key`; store_set a `key` to `value`; store_delete. signal: wake a wait with `value`, addressed by `runId` and `wait`, or by `workflow` and `channel`; answers a question as `{choice, reason?}`. withdraw: end the question `wait` of `runId` unanswered, with an optional `reason`; its run goes on as if the question timed out. resume: run a paused run's failed step again. cancel.",
  parameters: Schema.Struct({
    action: Schema.Literals([
      ...WORKFLOW_READ_ACTIONS,
      "hooks",
      "start",
      "signal",
      "resume",
      "cancel",
      "withdraw",
      "store_set",
      "store_delete",
    ]),
    workflow: Schema.optional(TrimmedNonEmptyString),
    input: Schema.optional(Schema.Json),
    idempotencyKey: Schema.optional(TrimmedNonEmptyString),
    runId: Schema.optional(TrimmedNonEmptyString),
    status: Schema.optional(WorkflowRunStatus),
    tag: Schema.optional(ExactName),
    kind: Schema.optional(ExactName),
    wait: Schema.optional(ExactName),
    key: Schema.optional(ExactName),
    channel: Schema.optional(ExactName),
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
    hooks: Schema.optional(Schema.Array(WorkflowHook)),
    entries: Schema.optional(
      Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.Json })),
    ),
    delivery: Schema.optional(Schema.Literals(["delivered", "buffered"])),
    withdrawal: Schema.optional(Schema.Literals(["withdrawn", "not_open"])),
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
