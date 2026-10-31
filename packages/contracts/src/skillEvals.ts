import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const SKILL_VARIANT_BODY_MAX_BYTES = 64 * 1024;
export const SKILL_BASE_BODY_MAX_BYTES = 256 * 1024;

export const SkillName = TrimmedNonEmptyString;
export type SkillName = typeof SkillName.Type;

export const SkillVariantRuleId = TrimmedNonEmptyString;
export type SkillVariantRuleId = typeof SkillVariantRuleId.Type;

export const SkillEvalTaskId = TrimmedNonEmptyString;
export type SkillEvalTaskId = typeof SkillEvalTaskId.Type;

export const SkillEvalRunId = TrimmedNonEmptyString;
export type SkillEvalRunId = typeof SkillEvalRunId.Type;

export const SkillEvalTrialId = TrimmedNonEmptyString;
export type SkillEvalTrialId = typeof SkillEvalTrialId.Type;

export const SkillEvalArmId = TrimmedNonEmptyString;
export type SkillEvalArmId = typeof SkillEvalArmId.Type;

export const SkillVariantMode = Schema.Literals(["variant", "off"]);
export type SkillVariantMode = typeof SkillVariantMode.Type;

export const SkillEffectiveMode = Schema.Literals(["variant", "off", "base"]);
export type SkillEffectiveMode = typeof SkillEffectiveMode.Type;

export const SkillVariantDelivery = Schema.Literals([
  "developer-context",
  "turn-prompt",
  "system-prompt",
  "unsupported",
]);
export type SkillVariantDelivery = typeof SkillVariantDelivery.Type;

const SkillVariantTargetFields = {
  skillName: SkillName,
  driver: Schema.optionalKey(Schema.NullOr(ProviderDriverKind)),
  model: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
};

export const SkillVariantRuleSummary = Schema.Struct({
  ruleId: SkillVariantRuleId,
  skillName: SkillName,
  driver: Schema.NullOr(ProviderDriverKind),
  model: Schema.NullOr(TrimmedNonEmptyString),
  mode: SkillVariantMode,
  enabled: Schema.Boolean,
  forkedFromRuleId: Schema.NullOr(SkillVariantRuleId),
  revision: PositiveInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type SkillVariantRuleSummary = typeof SkillVariantRuleSummary.Type;

export const SkillVariantRule = Schema.Struct({
  ...SkillVariantRuleSummary.fields,
  body: Schema.NullOr(Schema.String),
});
export type SkillVariantRule = typeof SkillVariantRule.Type;

export const SkillVariantRevisionAction = Schema.Literals([
  "create",
  "fork",
  "edit",
  "enable",
  "disable",
  "revert",
  "delete",
  "restore",
  "set-off",
  "set-variant",
]);
export type SkillVariantRevisionAction = typeof SkillVariantRevisionAction.Type;

export const SkillVariantRevision = Schema.Struct({
  ruleId: SkillVariantRuleId,
  revision: PositiveInt,
  action: SkillVariantRevisionAction,
  mode: SkillVariantMode,
  body: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  deleted: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type SkillVariantRevision = typeof SkillVariantRevision.Type;

export const SkillVariantMutateInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("create"),
    ...SkillVariantTargetFields,
    body: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("fork"),
    ...SkillVariantTargetFields,
    forkedFromRuleId: Schema.optionalKey(Schema.NullOr(SkillVariantRuleId)),
    body: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    action: Schema.Literal("edit"),
    ruleId: SkillVariantRuleId,
    body: Schema.String,
  }),
  Schema.Struct({ action: Schema.Literal("enable"), ruleId: SkillVariantRuleId }),
  Schema.Struct({ action: Schema.Literal("disable"), ruleId: SkillVariantRuleId }),
  Schema.Struct({ action: Schema.Literal("revert"), ruleId: SkillVariantRuleId }),
  Schema.Struct({ action: Schema.Literal("set-off"), ...SkillVariantTargetFields }),
  Schema.Struct({
    action: Schema.Literal("set-variant"),
    ...SkillVariantTargetFields,
    body: Schema.String,
  }),
  Schema.Struct({ action: Schema.Literal("delete"), ruleId: SkillVariantRuleId }),
  Schema.Struct({ action: Schema.Literal("restore"), ruleId: SkillVariantRuleId }),
]);
export type SkillVariantMutateInput = typeof SkillVariantMutateInput.Type;

export const SkillTurnResolutionEntry = Schema.Struct({
  skillName: SkillName,
  ruleId: Schema.NullOr(SkillVariantRuleId),
  revision: Schema.NullOr(PositiveInt),
  mode: SkillEffectiveMode,
  contentHash: Schema.NullOr(Schema.String),
  variantPath: Schema.NullOr(Schema.String),
  origin: Schema.Literals(["rule", "eval-arm"]),
});
export type SkillTurnResolutionEntry = typeof SkillTurnResolutionEntry.Type;

export const SkillTurnResolution = Schema.Struct({
  entries: Schema.Array(SkillTurnResolutionEntry),
  hash: Schema.String,
});
export type SkillTurnResolution = typeof SkillTurnResolution.Type;

export const SkillTurnEvidenceKind = Schema.Literals([
  "requested",
  "activated",
  "applied",
  "claimed",
]);
export type SkillTurnEvidenceKind = typeof SkillTurnEvidenceKind.Type;

export const SkillTurnEvidenceSource = Schema.Literals([
  "user_mention",
  "native_skill_tool",
  "variant_file_read",
  "skill_file_read",
  "skill_resource",
  "assistant_mention",
]);
export type SkillTurnEvidenceSource = typeof SkillTurnEvidenceSource.Type;

export const SkillTurnEvidence = Schema.Struct({
  runId: RunId,
  skillName: SkillName,
  kind: SkillTurnEvidenceKind,
  source: SkillTurnEvidenceSource,
  turnItemId: Schema.NullOr(TrimmedNonEmptyString),
  observedAt: IsoDateTime,
});
export type SkillTurnEvidence = typeof SkillTurnEvidence.Type;

export const SkillTurnTokenUsage = Schema.Struct({
  input: Schema.NullOr(NonNegativeInt),
  cachedInput: Schema.NullOr(NonNegativeInt),
  cacheCreation: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
  output: Schema.NullOr(NonNegativeInt),
  reasoning: Schema.NullOr(NonNegativeInt),
});
export type SkillTurnTokenUsage = typeof SkillTurnTokenUsage.Type;

export const SkillTurnOutcome = Schema.Struct({
  status: Schema.Literals(["completed", "interrupted", "failed", "cancelled"]),
  durationMs: Schema.NullOr(NonNegativeInt),
  toolCalls: NonNegativeInt,
  toolFailures: NonNegativeInt,
  errors: NonNegativeInt,
  tokens: Schema.NullOr(SkillTurnTokenUsage),
  costUsd: Schema.NullOr(Schema.Number),
  costSource: Schema.Literals(["model-priced", "provider-reported", "unavailable"]),
  reverted: Schema.Boolean,
  followupCorrection: Schema.NullOr(Schema.Boolean),
});
export type SkillTurnOutcome = typeof SkillTurnOutcome.Type;

export const SkillEvalTaskExpectation = Schema.Literals(["should-use", "should-not-use", "either"]);
export type SkillEvalTaskExpectation = typeof SkillEvalTaskExpectation.Type;

export const SkillEvalTask = Schema.Struct({
  taskId: SkillEvalTaskId,
  skillName: SkillName,
  projectId: ProjectId,
  promptType: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  rubric: TrimmedNonEmptyString,
  expectation: SkillEvalTaskExpectation.pipe(
    Schema.withDecodingDefault(Effect.succeed("either" as const)),
  ),
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  sourceRunId: Schema.NullOr(RunId),
  createdAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type SkillEvalTask = typeof SkillEvalTask.Type;

export const SkillEvalTaskMutateInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("add"),
    skillName: SkillName,
    projectId: ProjectId,
    promptType: TrimmedNonEmptyString,
    prompt: TrimmedNonEmptyString,
    rubric: TrimmedNonEmptyString,
    expectation: Schema.optionalKey(SkillEvalTaskExpectation),
    baseRef: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  }),
  Schema.Struct({
    action: Schema.Literal("update"),
    taskId: SkillEvalTaskId,
    promptType: Schema.optionalKey(TrimmedNonEmptyString),
    prompt: Schema.optionalKey(TrimmedNonEmptyString),
    rubric: Schema.optionalKey(TrimmedNonEmptyString),
    expectation: Schema.optionalKey(SkillEvalTaskExpectation),
    baseRef: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  }),
  Schema.Struct({ action: Schema.Literal("archive"), taskId: SkillEvalTaskId }),
  Schema.Struct({ action: Schema.Literal("restore"), taskId: SkillEvalTaskId }),
  Schema.Struct({
    action: Schema.Literal("promote-turn"),
    runId: RunId,
    skillName: SkillName,
    projectId: ProjectId,
    promptType: TrimmedNonEmptyString,
    rubric: TrimmedNonEmptyString,
    expectation: Schema.optionalKey(SkillEvalTaskExpectation),
    baseRef: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  }),
]);
export type SkillEvalTaskMutateInput = typeof SkillEvalTaskMutateInput.Type;

export const SkillEvalTaskSnapshot = Schema.Struct({
  taskId: SkillEvalTaskId,
  promptType: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  rubric: TrimmedNonEmptyString,
  expectation: SkillEvalTaskExpectation,
  baseCommit: TrimmedNonEmptyString,
});
export type SkillEvalTaskSnapshot = typeof SkillEvalTaskSnapshot.Type;

export const SkillEvalArm = Schema.Struct({
  armId: SkillEvalArmId,
  label: TrimmedNonEmptyString,
  kind: Schema.Literals(["off", "base", "variant"]),
  ruleId: Schema.optionalKey(SkillVariantRuleId),
  role: Schema.Literals(["control", "treatment"]),
});
export type SkillEvalArm = typeof SkillEvalArm.Type;

export function defaultSkillEvalArms(input: {
  readonly effectiveMode: SkillEffectiveMode;
  readonly ruleId: SkillVariantRuleId | null;
}): readonly [SkillEvalArm, SkillEvalArm] {
  if (input.effectiveMode === "variant") {
    if (input.ruleId === null) throw new Error("A variant evaluation arm requires a rule ID.");
    return [
      { armId: "off", label: "Off", kind: "off", role: "control" },
      {
        armId: "variant",
        label: "Current variant",
        kind: "variant",
        ruleId: input.ruleId,
        role: "treatment",
      },
    ];
  }
  if (input.effectiveMode === "off") {
    if (input.ruleId === null) throw new Error("An off evaluation arm requires a rule ID.");
    return [
      { armId: "base", label: "Base", kind: "base", role: "control" },
      {
        armId: "off",
        label: "Current off rule",
        kind: "off",
        ruleId: input.ruleId,
        role: "treatment",
      },
    ];
  }
  return [
    { armId: "off", label: "Off", kind: "off", role: "control" },
    { armId: "base", label: "Base", kind: "base", role: "treatment" },
  ];
}

export const SkillEvalRunConfig = Schema.Struct({
  skillName: SkillName,
  projectId: ProjectId,
  candidate: ModelSelection,
  arms: Schema.Array(SkillEvalArm).check(Schema.isMinLength(2), Schema.isMaxLength(4)),
  repeats: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  judge: Schema.NullOr(ModelSelection),
  judgeSamples: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  concurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
  taskIds: Schema.Array(SkillEvalTaskId),
  taskSnapshots: Schema.optionalKey(Schema.Array(SkillEvalTaskSnapshot)),
  variantRevisions: Schema.Record(SkillVariantRuleId, PositiveInt),
});
export type SkillEvalRunConfig = typeof SkillEvalRunConfig.Type;

export const SkillEvalRunStatus = Schema.Literals([
  "queued",
  "running",
  "judging",
  "completed",
  "cancelled",
  "failed",
  "interrupted",
]);
export type SkillEvalRunStatus = typeof SkillEvalRunStatus.Type;

export const SkillVerdictKind = Schema.Literals(["helps", "hurts", "not-enough-data"]);
export type SkillVerdictKind = typeof SkillVerdictKind.Type;

export const SkillVerdictReason = Schema.Literals([
  "too-few-tasks",
  "too-few-repeats",
  "wide-interval",
  "likely-negligible",
  "no-evaluations",
]);
export type SkillVerdictReason = typeof SkillVerdictReason.Type;

export const SkillVerdict = Schema.Struct({
  verdict: SkillVerdictKind,
  reason: Schema.NullOr(SkillVerdictReason),
  effect: Schema.NullOr(Schema.Number),
  ciLow: Schema.NullOr(Schema.Number),
  ciHigh: Schema.NullOr(Schema.Number),
  pAdjusted: Schema.NullOr(Schema.Number),
  nTasks: NonNegativeInt,
});
export type SkillVerdict = typeof SkillVerdict.Type;

export const SkillEvalCompletionSummary = Schema.Struct({
  rate: Schema.Number,
  ciLow: Schema.Number,
  ciHigh: Schema.Number,
});
export type SkillEvalCompletionSummary = typeof SkillEvalCompletionSummary.Type;

export const SkillEvalTriggerAccuracySummary = Schema.Struct({
  matched: NonNegativeInt,
  total: NonNegativeInt,
  rate: Schema.NullOr(Schema.Number),
});
export type SkillEvalTriggerAccuracySummary = typeof SkillEvalTriggerAccuracySummary.Type;

export const SkillEvalPromptTypeResult = Schema.Struct({
  promptType: TrimmedNonEmptyString,
  nTasks: NonNegativeInt,
  effect: Schema.NullOr(Schema.Number),
  ciLow: Schema.NullOr(Schema.Number),
  ciHigh: Schema.NullOr(Schema.Number),
  pAdjusted: Schema.NullOr(Schema.Number),
  rubricDifference: Schema.NullOr(Schema.Number),
  completion: SkillEvalCompletionSummary,
  controlCompletion: SkillEvalCompletionSummary,
  positionConsistency: Schema.NullOr(Schema.Number),
  triggerAccuracy: SkillEvalTriggerAccuracySummary,
});
export type SkillEvalPromptTypeResult = typeof SkillEvalPromptTypeResult.Type;

export const SkillEvalArmResult = Schema.Struct({
  armId: SkillEvalArmId,
  label: TrimmedNonEmptyString,
  kind: SkillEvalArm.fields.kind,
  role: SkillEvalArm.fields.role,
  nTasks: NonNegativeInt,
  repeats: PositiveInt,
  effect: Schema.NullOr(Schema.Number),
  ciLow: Schema.NullOr(Schema.Number),
  ciHigh: Schema.NullOr(Schema.Number),
  pAdjusted: Schema.NullOr(Schema.Number),
  rubricDifference: Schema.NullOr(Schema.Number),
  completion: SkillEvalCompletionSummary,
  controlCompletion: SkillEvalCompletionSummary,
  medianTokens: Schema.NullOr(Schema.Number),
  pairedMedianTokenDifference: Schema.NullOr(Schema.Number),
  medianDurationMs: Schema.NullOr(Schema.Number),
  pairedMedianDurationMsDifference: Schema.NullOr(Schema.Number),
  medianCostUsd: Schema.NullOr(Schema.Number),
  pairedMedianCostUsdDifference: Schema.NullOr(Schema.Number),
  positionConsistency: Schema.NullOr(Schema.Number),
  triggerAccuracy: SkillEvalTriggerAccuracySummary,
  promptTypeResults: Schema.Array(SkillEvalPromptTypeResult),
  judge: Schema.NullOr(ModelSelection),
  sameFamilyAsCandidate: Schema.Boolean,
  verdict: SkillVerdict,
});
export type SkillEvalArmResult = typeof SkillEvalArmResult.Type;

export const SkillEvalRunSummary = Schema.Struct({
  evalRunId: SkillEvalRunId,
  skillName: SkillName,
  config: SkillEvalRunConfig,
  status: SkillEvalRunStatus,
  error: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  armResults: Schema.Array(SkillEvalArmResult),
});
export type SkillEvalRunSummary = typeof SkillEvalRunSummary.Type;

export const SkillEvalTrial = Schema.Struct({
  trialId: SkillEvalTrialId,
  evalRunId: SkillEvalRunId,
  taskId: SkillEvalTaskId,
  armId: SkillEvalArmId,
  repeatIndex: NonNegativeInt,
  threadId: Schema.NullOr(ThreadId),
  runId: Schema.NullOr(RunId),
  status: Schema.Literals(["pending", "running", "completed", "failed", "cancelled"]),
  error: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type SkillEvalTrial = typeof SkillEvalTrial.Type;

export const SkillEvalRunDetail = Schema.Struct({
  ...SkillEvalRunSummary.fields,
  trials: Schema.Array(SkillEvalTrial),
});
export type SkillEvalRunDetail = typeof SkillEvalRunDetail.Type;

export const SkillEvalRunControlInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("start"), config: SkillEvalRunConfig }),
  Schema.Struct({ action: Schema.Literal("cancel"), evalRunId: SkillEvalRunId }),
  Schema.Struct({ action: Schema.Literal("resume"), evalRunId: SkillEvalRunId }),
]);
export type SkillEvalRunControlInput = typeof SkillEvalRunControlInput.Type;

export const SkillObservationalSummary = Schema.Struct({
  turns: NonNegativeInt,
  activationRate: Schema.NullOr(Schema.Number),
  completionRate: Schema.NullOr(Schema.Number),
  completionCiLow: Schema.NullOr(Schema.Number),
  completionCiHigh: Schema.NullOr(Schema.Number),
  revertRate: Schema.NullOr(Schema.Number),
  revertCiLow: Schema.NullOr(Schema.Number),
  revertCiHigh: Schema.NullOr(Schema.Number),
  toolFailureRate: Schema.NullOr(Schema.Number),
  medianTokens: Schema.NullOr(Schema.Number),
  medianDurationMs: Schema.NullOr(Schema.Number),
  confounded: Schema.Literal(true),
});
export type SkillObservationalSummary = typeof SkillObservationalSummary.Type;

export const SkillModelCell = Schema.Struct({
  driver: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  delivery: SkillVariantDelivery,
  gating: Schema.Literals(["native", "instruction", "none"]),
  effectiveMode: SkillEffectiveMode,
  ruleId: Schema.NullOr(SkillVariantRuleId),
  matchingRuleId: Schema.optionalKey(Schema.NullOr(SkillVariantRuleId)),
  verdict: SkillVerdict,
  observational: SkillObservationalSummary,
});
export type SkillModelCell = typeof SkillModelCell.Type;

export const SkillReviewListItem = Schema.Struct({
  skillName: SkillName,
  description: Schema.NullOr(Schema.String),
  providers: Schema.Array(ProviderDriverKind),
  cells: Schema.Array(SkillModelCell),
});
export type SkillReviewListItem = typeof SkillReviewListItem.Type;

export const SkillReviewDetail = Schema.Struct({
  skillName: SkillName,
  description: Schema.NullOr(Schema.String),
  providers: Schema.Array(ProviderDriverKind),
  rules: Schema.Array(SkillVariantRule),
  revisions: Schema.Array(SkillVariantRevision),
  tasks: Schema.Array(SkillEvalTask),
  runs: Schema.Array(SkillEvalRunSummary),
  ruleCount: Schema.optionalKey(NonNegativeInt),
  taskCount: Schema.optionalKey(NonNegativeInt),
  runCount: Schema.optionalKey(NonNegativeInt),
  cells: Schema.Array(SkillModelCell),
});
export type SkillReviewDetail = typeof SkillReviewDetail.Type;

export const SkillsReviewListInput = Schema.Struct({
  refresh: Schema.optional(Schema.Boolean),
});
export type SkillsReviewListInput = typeof SkillsReviewListInput.Type;

export const SKILL_REVIEW_EXTRA_MODELS_MAX = 8;

export const SkillsReviewGetInput = Schema.Struct({
  skillName: SkillName,
  /** Models to review beyond those with rules, usage, or eval history, so a first fork or eval has a cell. */
  models: Schema.optional(
    Schema.Array(Schema.Struct({ driver: ProviderDriverKind, model: TrimmedNonEmptyString })).check(
      Schema.isMaxLength(SKILL_REVIEW_EXTRA_MODELS_MAX),
    ),
  ),
});
export type SkillsReviewGetInput = typeof SkillsReviewGetInput.Type;

export const SkillsEvalRunGetInput = Schema.Struct({ evalRunId: SkillEvalRunId });
export type SkillsEvalRunGetInput = typeof SkillsEvalRunGetInput.Type;

export class SkillVariantNotFoundError extends Schema.TaggedError<SkillVariantNotFoundError>()(
  "SkillVariantNotFoundError",
  { ruleId: SkillVariantRuleId, message: Schema.String },
) {}

export class SkillVariantConflictError extends Schema.TaggedError<SkillVariantConflictError>()(
  "SkillVariantConflictError",
  {
    skillName: SkillName,
    driver: Schema.NullOr(ProviderDriverKind),
    model: Schema.NullOr(TrimmedNonEmptyString),
    conflictingRuleId: Schema.optionalKey(SkillVariantRuleId),
    message: Schema.String,
  },
) {}

export class SkillVariantValidationError extends Schema.TaggedError<SkillVariantValidationError>()(
  "SkillVariantValidationError",
  { message: Schema.String, ruleId: Schema.optionalKey(SkillVariantRuleId) },
) {}

export class SkillVariantPersistenceError extends Schema.TaggedError<SkillVariantPersistenceError>()(
  "SkillVariantPersistenceError",
  { operation: Schema.String, message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export class SkillEvalNotFoundError extends Schema.TaggedError<SkillEvalNotFoundError>()(
  "SkillEvalNotFoundError",
  {
    resource: Schema.Literals(["task", "run", "trial"]),
    id: TrimmedNonEmptyString,
    message: Schema.String,
  },
) {}

export class SkillEvalValidationError extends Schema.TaggedError<SkillEvalValidationError>()(
  "SkillEvalValidationError",
  { message: Schema.String },
) {}

export class SkillEvalJudgeUnavailableError extends Schema.TaggedError<SkillEvalJudgeUnavailableError>()(
  "SkillEvalJudgeUnavailableError",
  { message: Schema.String },
) {}

export class SkillEvalOperationError extends Schema.TaggedError<SkillEvalOperationError>()(
  "SkillEvalOperationError",
  { operation: Schema.String, message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export const SkillVariantMutationError = Schema.Union([
  SkillVariantNotFoundError,
  SkillVariantConflictError,
  SkillVariantValidationError,
  SkillVariantPersistenceError,
]);
export type SkillVariantMutationError = typeof SkillVariantMutationError.Type;

export const SkillEvalError = Schema.Union([
  SkillEvalNotFoundError,
  SkillEvalValidationError,
  SkillEvalJudgeUnavailableError,
  SkillEvalOperationError,
]);
export type SkillEvalError = typeof SkillEvalError.Type;

export const SkillsReadError = Schema.Union([
  SkillVariantPersistenceError,
  SkillEvalNotFoundError,
  SkillEvalOperationError,
]);
export type SkillsReadError = typeof SkillsReadError.Type;
