import {
  McpCapabilityUnavailableError,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderDriverKind,
  RunId,
  SkillEvalArm,
  SkillEvalError,
  SkillEvalRunConfig,
  SkillEvalRunDetail,
  SkillEvalRunId,
  SkillEvalRunSummary,
  SkillEvalTask,
  SkillEvalTaskExpectation,
  SkillEvalTaskId,
  SkillName,
  SkillReviewDetail,
  SkillReviewListItem,
  SkillsReadError,
  SkillVariantMutationError,
  SkillVariantRule,
  SkillVariantRuleId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SkillReviewService from "../../../skills/SkillReviewService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  SkillReviewService.SkillReviewService,
];

export const SkillsToolError = Schema.Union([
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  SkillsReadError,
  SkillVariantMutationError,
  SkillEvalError,
]);

export const SkillsReviewInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  skillName: Schema.optional(SkillName),
  includeBodies: Schema.optional(Schema.Boolean),
  refresh: Schema.optional(Schema.Boolean),
});
export type SkillsReviewInput = typeof SkillsReviewInput.Type;

export const SkillVariantUpdateInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  action: Schema.Literals([
    "create",
    "fork",
    "edit",
    "enable",
    "disable",
    "revert",
    "set-off",
    "delete",
    "restore",
  ]),
  skillName: Schema.optional(SkillName),
  driver: Schema.optional(Schema.NullOr(ProviderDriverKind)),
  model: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  ruleId: Schema.optional(SkillVariantRuleId),
  forkedFromRuleId: Schema.optional(Schema.NullOr(SkillVariantRuleId)),
  body: Schema.optional(Schema.String),
});
export type SkillVariantUpdateInput = typeof SkillVariantUpdateInput.Type;

export const SkillEvalTasksInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  action: Schema.Literals(["list", "add", "update", "archive", "restore", "promote-turn"]),
  skillName: Schema.optional(SkillName),
  projectId: Schema.optional(ProjectId),
  taskId: Schema.optional(SkillEvalTaskId),
  promptType: Schema.optional(TrimmedNonEmptyString),
  prompt: Schema.optional(TrimmedNonEmptyString),
  rubric: Schema.optional(TrimmedNonEmptyString),
  expectation: Schema.optional(SkillEvalTaskExpectation),
  baseRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  runId: Schema.optional(RunId),
  includeArchived: Schema.optional(Schema.Boolean),
});
export type SkillEvalTasksInput = typeof SkillEvalTasksInput.Type;

export const SkillEvalRunStartConfig = Schema.Struct({
  ...SkillEvalRunConfig.fields,
  arms: Schema.optional(
    Schema.Array(SkillEvalArm).check(Schema.isMinLength(2), Schema.isMaxLength(4)),
  ),
});
export type SkillEvalRunStartConfig = typeof SkillEvalRunStartConfig.Type;

export const SkillEvalRunInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  action: Schema.Literals(["start", "status", "cancel", "resume"]),
  evalRunId: Schema.optional(SkillEvalRunId),
  config: Schema.optional(SkillEvalRunStartConfig),
});
export type SkillEvalRunInput = typeof SkillEvalRunInput.Type;

const SkillsReviewTool = Tool.make("skills_review", {
  description:
    "List skills with per-model verdicts, or one skill with skillName. refresh rescans project catalogs.",
  parameters: SkillsReviewInput,
  success: Schema.Union([Schema.Array(SkillReviewListItem), SkillReviewDetail]),
  failure: SkillsToolError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Review model-specific skills")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SkillVariantUpdateTool = Tool.make("skill_variant_update", {
  description:
    "Change a per-model skill rule. driver/model scope it; omit both for all. fork without body copies the base skill. Every action has a reverse: enable/disable, edit/revert, set-off/delete, delete/restore.",
  parameters: SkillVariantUpdateInput,
  success: SkillVariantRule,
  failure: SkillsToolError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update a skill variant")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const SkillEvalTasksTool = Tool.make("skill_eval_tasks", {
  description:
    "List, add, update, archive, or restore eval tasks; promote-turn copies a real turn into a task.",
  parameters: SkillEvalTasksInput,
  success: Schema.Union([Schema.Array(SkillEvalTask), SkillEvalTask]),
  failure: SkillsToolError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Manage skill evaluation tasks")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const SkillEvalRunTool = Tool.make("skill_eval_run", {
  description:
    "Start, status, cancel, or resume a skill eval. Start is async and runs real agents in isolated worktrees. Omit config.arms to compare skill off with the current variant.",
  parameters: SkillEvalRunInput,
  success: Schema.Union([SkillEvalRunSummary, SkillEvalRunDetail]),
  failure: SkillsToolError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Control a skill evaluation run")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const SkillsToolkit = Toolkit.make(
  SkillsReviewTool,
  SkillVariantUpdateTool,
  SkillEvalTasksTool,
  SkillEvalRunTool,
);
