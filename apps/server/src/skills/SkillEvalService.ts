import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import {
  CommandId,
  OrchestrationV2ConversationMessageJson,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  isProviderAvailable,
  resolveProjectProviderInstanceEnabled,
  SkillEvalJudgeUnavailableError,
  SkillEvalNotFoundError,
  SkillEvalOperationError,
  SkillEvalRunConfig,
  SkillEvalRunDetail,
  SkillEvalRunId,
  type SkillEvalRunStatus,
  SkillEvalTask,
  type SkillEvalTaskExpectation,
  SkillEvalTaskId,
  type SkillEvalTaskSnapshot,
  type SkillEvalTaskMutateInput,
  SkillEvalTrialId,
  SkillEvalValidationError,
  SkillTurnOutcome,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2RuntimeRequest,
  type ServerProvider,
  type SkillEvalArm,
  type SkillEvalArmResult,
  type SkillEvalError,
  type SkillEvalRunControlInput,
  type SkillEvalRunSummary,
  type SkillEvalTrial,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { TrialTranscript } from "@t3tools/provider-core/server/textGeneration";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  buildSkillTrialTranscript,
  judgeSharesCandidateFamily,
  mapPositionalSkillTrialJudgment,
  resolveSkillEvalJudge,
  type ResolvedSkillEvalJudge,
} from "./skillEvalJudge.ts";
import {
  armOutcomeSummary,
  holmAdjust,
  pairedTaskEffect,
  skillVerdict,
  type ArmOutcomeTrial,
  type JudgmentObservation,
  type PairedTaskEffect,
  type WilsonInterval,
} from "./skillEvalStats.ts";
import * as SkillUsage from "./SkillUsageService.ts";

const TRIAL_WAIT_TIMEOUT_MS = 12 * 60 * 60 * 1_000;
const MAX_ERROR_CHARS = 2_000;
const FINALIZE_BATCH_SIZE = 500;
const DEFAULT_RUN_LIST_LIMIT = 20;
const MAX_LATEST_VERDICTS = 100;

interface SkillEvalTaskRow {
  readonly task_id: string;
  readonly skill_name: string;
  readonly project_id: string;
  readonly prompt_type: string;
  readonly prompt: string;
  readonly rubric: string;
  readonly expectation: SkillEvalTaskExpectation;
  readonly base_ref: string | null;
  readonly source_run_id: string | null;
  readonly created_at: string;
  readonly archived_at: string | null;
}

interface SkillEvalRunRow {
  readonly eval_run_id: string;
  readonly skill_name: string;
  readonly config_json: string;
  readonly status: SkillEvalRunStatus;
  readonly error: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

interface SkillEvalTrialRow {
  readonly trial_id: string;
  readonly eval_run_id: string;
  readonly task_id: string;
  readonly arm_id: string;
  readonly repeat_index: number;
  readonly thread_id: string | null;
  readonly run_id: string | null;
  readonly status: SkillEvalTrial["status"];
  readonly error: string | null;
  readonly created_at: string;
  readonly completed_at: string | null;
}

interface SkillEvalJudgmentRow {
  readonly judgment_id: string;
  readonly eval_run_id: string;
  readonly task_id: string;
  readonly repeat_index: number;
  readonly treatment_arm_id: string;
  readonly control_arm_id: string;
  readonly order_label: "treatment-first" | "control-first";
  readonly sample_index: number;
  readonly preferred: JudgmentObservation["preferred"];
  readonly treatment_score: number | null;
  readonly control_score: number | null;
  readonly rationale: string;
  readonly judge_instance_id: string;
  readonly judge_model: string;
  readonly created_at: string;
}

interface SkillTurnOutcomeRow {
  readonly eval_trial_id: string;
  readonly outcome_json: string | null;
  readonly activated: number;
}

interface PromotedTurnRow {
  readonly project_id: string;
  readonly payload_json: string;
}

interface VariantRevisionRow {
  readonly rule_id: string;
  readonly revision: number;
}

interface ActiveRunRow {
  readonly eval_run_id: string;
}

export interface SkillEvalTrialCell {
  readonly taskId: SkillEvalTaskId;
  readonly armId: SkillEvalArm["armId"];
  readonly repeatIndex: number;
}

export interface LatestSkillEvalVerdict {
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly config: SkillEvalRunConfig;
  readonly armVerdicts: ReadonlyArray<{
    readonly armId: string;
    readonly verdict: SkillEvalArmResult["verdict"];
  }>;
}

interface SkillEvalVerdictTrialRow {
  readonly eval_run_id: string;
  readonly task_id: string;
  readonly arm_id: string;
  readonly repeat_index: number;
  readonly status: SkillEvalTrial["status"];
}

interface SkillEvalVerdictJudgmentRow {
  readonly eval_run_id: string;
  readonly task_id: string;
  readonly repeat_index: number;
  readonly treatment_arm_id: string;
  readonly order_label: "treatment-first" | "control-first";
  readonly sample_index: number;
  readonly preferred: JudgmentObservation["preferred"];
  readonly treatment_score: number | null;
  readonly control_score: number | null;
}

interface TrialMetric {
  readonly taskId: SkillEvalTaskId;
  readonly repeatIndex: number;
  readonly status: SkillEvalTrial["status"];
  readonly tokens: number | null;
  readonly durationMs: number | null;
  readonly costUsd: number | null;
  readonly activated: boolean;
}

interface RunAssemblyContext {
  readonly row: SkillEvalRunRow;
  readonly config: SkillEvalRunConfig;
  readonly trials: ReadonlyArray<SkillEvalTrial>;
  readonly tasks: ReadonlyMap<SkillEvalTaskId, SkillEvalTaskSnapshot>;
  readonly judgments: ReadonlyArray<SkillEvalJudgmentRow>;
  readonly outcomes: ReadonlyMap<SkillEvalTrialId, SkillTurnOutcomeRow>;
  readonly providers: ReadonlyArray<ServerProvider>;
}

const decodeTask = Schema.decodeUnknownEffect(SkillEvalTask);
const decodeRunConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(SkillEvalRunConfig));
const encodeRunConfig = Schema.encodeUnknownSync(Schema.fromJsonString(SkillEvalRunConfig));
const decodeRunDetail = Schema.decodeUnknownEffect(SkillEvalRunDetail);
const decodeConversationMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);
const decodeOutcome = Schema.decodeUnknownEffect(Schema.fromJsonString(SkillTurnOutcome));
const isNotFoundError = Schema.is(SkillEvalNotFoundError);
const isValidationError = Schema.is(SkillEvalValidationError);
const isJudgeUnavailableError = Schema.is(SkillEvalJudgeUnavailableError);
const isOperationError = Schema.is(SkillEvalOperationError);

const normalizeSkillName = (value: string): string => value.trim().toLowerCase();

const causeMessage = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause)).slice(0, MAX_ERROR_CHARS);

const operationError = (operation: string, cause: unknown) =>
  new SkillEvalOperationError({
    operation,
    message: `Could not ${operation.replaceAll("-", " ")}.`,
    cause,
  });

function preserveEvalError(operation: string, cause: unknown): SkillEvalError {
  if (
    isNotFoundError(cause) ||
    isValidationError(cause) ||
    isJudgeUnavailableError(cause) ||
    isOperationError(cause)
  ) {
    return cause;
  }
  return operationError(operation, cause);
}

const taskNotFound = (taskId: SkillEvalTaskId) =>
  new SkillEvalNotFoundError({
    resource: "task",
    id: taskId,
    message: `Skill evaluation task '${taskId}' was not found.`,
  });

const runNotFound = (evalRunId: SkillEvalRunId) =>
  new SkillEvalNotFoundError({
    resource: "run",
    id: evalRunId,
    message: `Skill evaluation run '${evalRunId}' was not found.`,
  });

const taskFromRow = (row: SkillEvalTaskRow) =>
  decodeTask({
    taskId: row.task_id,
    skillName: row.skill_name,
    projectId: row.project_id,
    promptType: row.prompt_type,
    prompt: row.prompt,
    rubric: row.rubric,
    expectation: row.expectation,
    baseRef: row.base_ref,
    sourceRunId: row.source_run_id,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  });

const trialFromRow = (row: SkillEvalTrialRow): SkillEvalTrial => ({
  trialId: SkillEvalTrialId.make(row.trial_id),
  evalRunId: SkillEvalRunId.make(row.eval_run_id),
  taskId: SkillEvalTaskId.make(row.task_id),
  armId: row.arm_id,
  repeatIndex: row.repeat_index,
  threadId: row.thread_id === null ? null : ThreadId.make(row.thread_id),
  runId: row.run_id === null ? null : RunId.make(row.run_id),
  status: row.status,
  error: row.error,
  createdAt: row.created_at,
  completedAt: row.completed_at,
});

const seedFromString = (seed: string): number => {
  let value = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
};

const seededRandom = (seed: string) => {
  let state = seedFromString(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

export function deterministicSkillEvalShuffle<A>(
  values: ReadonlyArray<A>,
  seed: string,
): ReadonlyArray<A> {
  const shuffled = [...values];
  const random = seededRandom(seed);
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    const value = shuffled[index];
    shuffled[index] = shuffled[target] as A;
    shuffled[target] = value as A;
  }
  return shuffled;
}

export function buildSkillEvalTrialCells(input: {
  readonly evalRunId: SkillEvalRunId;
  readonly taskIds: ReadonlyArray<SkillEvalTaskId>;
  readonly arms: ReadonlyArray<SkillEvalArm>;
  readonly repeats: number;
}): ReadonlyArray<SkillEvalTrialCell> {
  const cells: SkillEvalTrialCell[] = [];
  for (const taskId of input.taskIds) {
    for (let repeatIndex = 0; repeatIndex < input.repeats; repeatIndex += 1) {
      for (const arm of input.arms) cells.push({ taskId, armId: arm.armId, repeatIndex });
    }
  }
  return deterministicSkillEvalShuffle(cells, input.evalRunId);
}

const completionSummary = (interval: WilsonInterval | null) => ({
  rate: interval?.estimate ?? 0,
  ciLow: interval?.low ?? 0,
  ciHigh: interval?.high ?? 0,
});

const median = (values: ReadonlyArray<number>): number | null => {
  if (values.length === 0) return null;
  const ordered = values.toSorted((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? (ordered[middle] ?? null)
    : ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
};

const pairedMedianDifference = (
  treatment: ReadonlyArray<TrialMetric>,
  control: ReadonlyArray<TrialMetric>,
  select: (metric: TrialMetric) => number | null,
): number | null => {
  const controlByCell = new Map(
    control.map((metric) => [`${metric.taskId}\u0000${metric.repeatIndex}`, metric] as const),
  );
  const differences: number[] = [];
  for (const metric of treatment) {
    const controlMetric = controlByCell.get(`${metric.taskId}\u0000${metric.repeatIndex}`);
    if (controlMetric === undefined) continue;
    const treatmentValue = select(metric);
    const controlValue = select(controlMetric);
    if (treatmentValue !== null && controlValue !== null) {
      differences.push(treatmentValue - controlValue);
    }
  }
  return median(differences);
};

const triggerAccuracy = (
  trials: ReadonlyArray<TrialMetric>,
  tasks: ReadonlyMap<SkillEvalTaskId, SkillEvalTaskSnapshot>,
) => {
  let matched = 0;
  let total = 0;
  for (const trial of trials) {
    const expectation = tasks.get(trial.taskId)?.expectation ?? "either";
    if (expectation === "either" || trial.status !== "completed") continue;
    total += 1;
    if (
      (expectation === "should-use" && trial.activated) ||
      (expectation === "should-not-use" && !trial.activated)
    ) {
      matched += 1;
    }
  }
  return { matched, total, rate: total === 0 ? null : matched / total };
};

const outcomeTokenCount = (outcome: SkillTurnOutcome): number | null => {
  if (outcome.tokens === null) return null;
  const input = outcome.tokens.input;
  const output = outcome.tokens.output;
  return input === null && output === null ? null : (input ?? 0) + (output ?? 0);
};

const judgmentObservation = (
  row: Pick<
    SkillEvalJudgmentRow,
    | "task_id"
    | "repeat_index"
    | "order_label"
    | "sample_index"
    | "preferred"
    | "treatment_score"
    | "control_score"
  >,
): JudgmentObservation => ({
  taskId: row.task_id,
  repeatIndex: row.repeat_index,
  orderLabel: row.order_label,
  sampleIndex: row.sample_index,
  preferred: row.preferred,
  treatmentScore: row.treatment_score,
  controlScore: row.control_score,
});

const adjustedValues = (
  effects: ReadonlyArray<{ readonly armId: string; readonly effect: PairedTaskEffect }>,
) => {
  const known = effects.filter(
    (
      entry,
    ): entry is {
      readonly armId: string;
      readonly effect: PairedTaskEffect & { pValue: number };
    } => entry.effect.pValue !== null,
  );
  const adjusted = holmAdjust(known.map((entry) => entry.effect.pValue));
  return new Map(known.map((entry, index) => [entry.armId, adjusted[index] ?? null] as const));
};

function assembleLatestSkillEvalArmVerdicts(input: {
  readonly config: SkillEvalRunConfig;
  readonly trials: ReadonlyArray<Pick<SkillEvalVerdictTrialRow, "arm_id" | "status">>;
  readonly judgments: ReadonlyArray<SkillEvalVerdictJudgmentRow>;
}): LatestSkillEvalVerdict["armVerdicts"] {
  const control = input.config.arms.find((arm) => arm.role === "control");
  if (control === undefined) return [];

  const effects = input.config.arms
    .filter((arm) => arm.role === "treatment")
    .map((arm) => ({
      armId: arm.armId,
      effect: pairedTaskEffect(
        input.judgments
          .filter((row) => row.treatment_arm_id === arm.armId)
          .map(judgmentObservation),
      ),
    }));
  const adjusted = adjustedValues(effects);
  const completionFor = (armId: string) =>
    armOutcomeSummary(
      input.trials
        .filter((trial) => trial.arm_id === armId)
        .map((trial) => ({
          status: trial.status,
          tokens: null,
          durationMs: null,
          costUsd: null,
        })),
    ).completion;
  const controlCompletion = completionFor(control.armId);

  return effects.map(({ armId, effect }) => {
    const pAdjusted = adjusted.get(armId) ?? null;
    return {
      armId,
      verdict: {
        ...skillVerdict({
          effect,
          adjustedP: pAdjusted,
          treatmentCompletion: completionFor(armId),
          controlCompletion,
          repeats: input.config.repeats,
          judgeSamples: input.config.judgeSamples,
        }),
        effect: effect.mean,
        ciLow: effect.ci?.low ?? null,
        ciHigh: effect.ci?.high ?? null,
        pAdjusted,
        nTasks: effect.n,
      },
    };
  });
}

export const assembleSkillEvalArmResults = Effect.fn(
  "SkillEvalService.assembleSkillEvalArmResults",
)(function* (context: RunAssemblyContext) {
  const control = context.config.arms.find((arm) => arm.role === "control");
  if (control === undefined) {
    return yield* new SkillEvalValidationError({
      message: "An evaluation run must have exactly one control arm.",
    });
  }

  const metricsByArm = new Map<string, TrialMetric[]>();
  for (const trial of context.trials) {
    const stored = context.outcomes.get(trial.trialId);
    const outcome =
      stored?.outcome_json === null || stored?.outcome_json === undefined
        ? null
        : yield* decodeOutcome(stored.outcome_json);
    const metrics = metricsByArm.get(trial.armId) ?? [];
    metrics.push({
      taskId: trial.taskId,
      repeatIndex: trial.repeatIndex,
      status: trial.status,
      tokens: outcome === null ? null : outcomeTokenCount(outcome),
      durationMs: outcome?.durationMs ?? null,
      costUsd: outcome?.costUsd ?? null,
      activated: stored?.activated !== 0 && stored !== undefined,
    });
    metricsByArm.set(trial.armId, metrics);
  }

  const treatmentEffects = context.config.arms
    .filter((arm) => arm.role === "treatment")
    .map((arm) => ({
      armId: arm.armId,
      effect: pairedTaskEffect(
        context.judgments
          .filter((row) => row.treatment_arm_id === arm.armId)
          .map(judgmentObservation),
      ),
    }));
  const adjusted = adjustedValues(treatmentEffects);
  const promptTypes = [
    ...new Set([...context.tasks.values()].map((task) => task.promptType)),
  ].sort();
  const promptEffects = new Map<
    string,
    ReadonlyArray<{ readonly armId: string; readonly effect: PairedTaskEffect }>
  >();
  const promptAdjusted = new Map<string, ReadonlyMap<string, number | null>>();
  for (const promptType of promptTypes) {
    const taskIds = new Set(
      [...context.tasks.values()]
        .filter((task) => task.promptType === promptType)
        .map((task) => task.taskId),
    );
    const entries = context.config.arms
      .filter((arm) => arm.role === "treatment")
      .map((arm) => ({
        armId: arm.armId,
        effect: pairedTaskEffect(
          context.judgments
            .filter((row) => row.treatment_arm_id === arm.armId && taskIds.has(row.task_id))
            .map(judgmentObservation),
        ),
      }));
    promptEffects.set(promptType, entries);
    promptAdjusted.set(promptType, adjustedValues(entries));
  }

  const controlMetrics = metricsByArm.get(control.armId) ?? [];
  const controlOutcomes = armOutcomeSummary(controlMetrics as ReadonlyArray<ArmOutcomeTrial>);
  const judgeSelection: ModelSelection | null =
    context.judgments[0] === undefined
      ? context.config.judge
      : {
          instanceId: ProviderInstanceId.make(context.judgments[0].judge_instance_id),
          model: context.judgments[0].judge_model,
        };
  const sameFamilyAsCandidate =
    judgeSelection !== null
      ? judgeSharesCandidateFamily({
          judge: judgeSelection,
          candidate: context.config.candidate,
        })
      : false;

  const results: SkillEvalArmResult[] = [];
  for (const arm of context.config.arms) {
    const metrics = metricsByArm.get(arm.armId) ?? [];
    const outcomes = armOutcomeSummary(metrics as ReadonlyArray<ArmOutcomeTrial>);
    const effect =
      treatmentEffects.find((entry) => entry.armId === arm.armId)?.effect ?? pairedTaskEffect([]);
    const pAdjusted = adjusted.get(arm.armId) ?? null;
    const verdict = skillVerdict({
      effect,
      adjustedP: pAdjusted,
      treatmentCompletion: outcomes.completion,
      controlCompletion: controlOutcomes.completion,
      repeats: context.config.repeats,
      judgeSamples: context.config.judgeSamples,
    });
    const promptTypeResults = promptTypes.map((promptType) => {
      const taskIds = new Set(
        [...context.tasks.values()]
          .filter((task) => task.promptType === promptType)
          .map((task) => task.taskId),
      );
      const promptMetrics = metrics.filter((metric) => taskIds.has(metric.taskId));
      const promptControlMetrics = controlMetrics.filter((metric) => taskIds.has(metric.taskId));
      const promptOutcome = armOutcomeSummary(promptMetrics as ReadonlyArray<ArmOutcomeTrial>);
      const promptControlOutcome = armOutcomeSummary(
        promptControlMetrics as ReadonlyArray<ArmOutcomeTrial>,
      );
      const promptEffect =
        promptEffects.get(promptType)?.find((entry) => entry.armId === arm.armId)?.effect ??
        pairedTaskEffect([]);
      const adjustedP = promptAdjusted.get(promptType)?.get(arm.armId) ?? null;
      return {
        promptType,
        nTasks: promptEffect.n,
        effect: promptEffect.mean,
        ciLow: promptEffect.ci?.low ?? null,
        ciHigh: promptEffect.ci?.high ?? null,
        pAdjusted: adjustedP,
        rubricDifference: promptEffect.rubricDiff.mean,
        completion: completionSummary(promptOutcome.completion),
        controlCompletion: completionSummary(promptControlOutcome.completion),
        positionConsistency: promptEffect.positionConsistency,
        triggerAccuracy: triggerAccuracy(promptMetrics, context.tasks),
      };
    });
    results.push({
      armId: arm.armId,
      label: arm.label,
      kind: arm.kind,
      role: arm.role,
      nTasks: effect.n,
      repeats: context.config.repeats,
      effect: effect.mean,
      ciLow: effect.ci?.low ?? null,
      ciHigh: effect.ci?.high ?? null,
      pAdjusted,
      rubricDifference: effect.rubricDiff.mean,
      completion: completionSummary(outcomes.completion),
      controlCompletion: completionSummary(controlOutcomes.completion),
      medianTokens: outcomes.tokens.median,
      pairedMedianTokenDifference: pairedMedianDifference(
        metrics,
        controlMetrics,
        (metric) => metric.tokens,
      ),
      medianDurationMs: outcomes.durationMs.median,
      pairedMedianDurationMsDifference: pairedMedianDifference(
        metrics,
        controlMetrics,
        (metric) => metric.durationMs,
      ),
      medianCostUsd: outcomes.costUsd.median,
      pairedMedianCostUsdDifference: pairedMedianDifference(
        metrics,
        controlMetrics,
        (metric) => metric.costUsd,
      ),
      positionConsistency: effect.positionConsistency,
      triggerAccuracy: triggerAccuracy(metrics, context.tasks),
      promptTypeResults,
      judge: judgeSelection,
      sameFamilyAsCandidate,
      verdict: {
        ...verdict,
        effect: effect.mean,
        ciLow: effect.ci?.low ?? null,
        ciHigh: effect.ci?.high ?? null,
        pAdjusted,
        nTasks: effect.n,
      },
    });
  }
  return results;
});

export const interruptActiveSkillEvalRuns = Effect.fn(
  "SkillEvalService.interruptActiveRunsOnStartup",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  const rows = yield* sql<ActiveRunRow>`
    UPDATE skill_eval_runs
    SET status = 'interrupted',
        error = 'The server stopped before this evaluation completed. Resume it to continue missing work.',
        completed_at = ${now}
    WHERE status IN ('queued', 'running', 'judging')
    RETURNING eval_run_id
  `;
  return rows.map((row) => SkillEvalRunId.make(row.eval_run_id));
});

export class SkillEvalService extends Context.Service<
  SkillEvalService,
  {
    readonly listTasks: (input: {
      readonly skillName: string;
      readonly includeArchived?: boolean;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<SkillEvalTask>, SkillEvalError>;
    readonly mutateTask: (
      input: SkillEvalTaskMutateInput,
    ) => Effect.Effect<SkillEvalTask, SkillEvalError>;
    readonly start: (
      config: SkillEvalRunConfig,
    ) => Effect.Effect<SkillEvalRunSummary, SkillEvalError>;
    readonly cancel: (
      evalRunId: SkillEvalRunId,
    ) => Effect.Effect<SkillEvalRunSummary, SkillEvalError>;
    readonly resume: (
      evalRunId: SkillEvalRunId,
    ) => Effect.Effect<SkillEvalRunSummary, SkillEvalError>;
    readonly control: (
      input: SkillEvalRunControlInput,
    ) => Effect.Effect<SkillEvalRunSummary, SkillEvalError>;
    readonly getRun: (
      evalRunId: SkillEvalRunId,
    ) => Effect.Effect<SkillEvalRunDetail, SkillEvalError>;
    readonly listRuns: (
      skillName: string,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<SkillEvalRunSummary>, SkillEvalError>;
    readonly latestVerdicts: (
      skillName: string,
    ) => Effect.Effect<ReadonlyArray<LatestSkillEvalVerdict>, SkillEvalError>;
  }
>()("t3/skills/SkillEvalService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectService.ProjectService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const providerAdapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const threadManagement = yield* ThreadManagement.ThreadManagementService;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
  const skillUsage = yield* SkillUsage.SkillUsageService;
  const scope = yield* Scope.Scope;
  const fibers = yield* Ref.make<ReadonlyMap<SkillEvalRunId, Fiber.Fiber<void, never>>>(new Map());

  yield* interruptActiveSkillEvalRuns();

  const selectTask = (taskId: SkillEvalTaskId) => sql<SkillEvalTaskRow>`
    SELECT task_id, skill_name, project_id, prompt_type, prompt, rubric, expectation,
           base_ref, source_run_id, created_at, archived_at
    FROM skill_eval_tasks
    WHERE task_id = ${taskId}
  `;

  const loadTask = Effect.fn("SkillEvalService.loadTask")(function* (taskId: SkillEvalTaskId) {
    const rows = yield* selectTask(taskId);
    if (rows[0] === undefined) return yield* taskNotFound(taskId);
    return yield* taskFromRow(rows[0]);
  });

  const selectRun = (evalRunId: SkillEvalRunId) => sql<SkillEvalRunRow>`
    SELECT eval_run_id, skill_name, config_json, status, error, created_at, started_at, completed_at
    FROM skill_eval_runs
    WHERE eval_run_id = ${evalRunId}
  `;

  const loadRunRow = Effect.fn("SkillEvalService.loadRunRow")(function* (
    evalRunId: SkillEvalRunId,
  ) {
    const rows = yield* selectRun(evalRunId);
    if (rows[0] === undefined) return yield* runNotFound(evalRunId);
    return rows[0];
  });

  const loadRunConfig = Effect.fn("SkillEvalService.loadRunConfig")(function* (
    row: SkillEvalRunRow,
  ) {
    return yield* decodeRunConfig(row.config_json);
  });

  const projectFor = Effect.fn("SkillEvalService.projectFor")(function* (projectId: ProjectId) {
    const project = Option.getOrUndefined(yield* projects.getById(projectId));
    if (project === undefined) {
      return yield* new SkillEvalValidationError({
        message: `Project '${projectId}' was not found.`,
      });
    }
    return project;
  });

  const taskSnapshotsFor = Effect.fn("SkillEvalService.taskSnapshotsFor")(function* (
    config: SkillEvalRunConfig,
  ) {
    if (config.taskSnapshots !== undefined) {
      const snapshots = new Map(
        config.taskSnapshots.map((snapshot) => [snapshot.taskId, snapshot] as const),
      );
      if (
        snapshots.size !== config.taskIds.length ||
        config.taskIds.some((taskId) => !snapshots.has(taskId))
      ) {
        return yield* new SkillEvalValidationError({
          message: "The frozen evaluation task snapshots do not match the run task ids.",
        });
      }
      return snapshots;
    }

    const rows = yield* sql<SkillEvalTaskRow>`
      SELECT task_id, skill_name, project_id, prompt_type, prompt, rubric, expectation,
             base_ref, source_run_id, created_at, archived_at
      FROM skill_eval_tasks
      WHERE task_id IN ${sql.in(config.taskIds)}
    `.pipe(NodeSqliteClient.readOnly);
    const tasks = yield* Effect.forEach(rows, taskFromRow, { concurrency: 1 });
    return new Map(
      tasks.map(
        (task) =>
          [
            task.taskId,
            {
              taskId: task.taskId,
              promptType: task.promptType,
              prompt: task.prompt,
              rubric: task.rubric,
              expectation: task.expectation,
              baseCommit: task.baseRef ?? "HEAD",
            },
          ] as const,
      ),
    );
  });

  const listTasks = Effect.fn("SkillEvalService.listTasks")(function* (input: {
    readonly skillName: string;
    readonly includeArchived?: boolean;
    readonly limit?: number;
  }) {
    const skillName = normalizeSkillName(input.skillName);
    const limit = Math.max(1, Math.trunc(input.limit ?? 10_000));
    const rows = yield* sql<SkillEvalTaskRow>`
      SELECT task_id, skill_name, project_id, prompt_type, prompt, rubric, expectation,
             base_ref, source_run_id, created_at, archived_at
      FROM skill_eval_tasks
      WHERE skill_name = ${skillName}
        AND (${input.includeArchived === true ? 1 : 0} = 1 OR archived_at IS NULL)
      ORDER BY created_at DESC, task_id DESC
      LIMIT ${limit}
    `.pipe(NodeSqliteClient.readOnly);
    return yield* Effect.forEach(rows, taskFromRow, { concurrency: 1 });
  });

  const insertTask = Effect.fn("SkillEvalService.insertTask")(function* (input: {
    readonly skillName: string;
    readonly projectId: ProjectId;
    readonly promptType: string;
    readonly prompt: string;
    readonly rubric: string;
    readonly expectation: SkillEvalTaskExpectation;
    readonly baseRef: string | null;
    readonly sourceRunId: RunId | null;
  }) {
    const taskId = SkillEvalTaskId.make(yield* randomUuidV4);
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO skill_eval_tasks (
        task_id, skill_name, project_id, prompt_type, prompt, rubric, expectation,
        base_ref, source_run_id, created_at, archived_at
      ) VALUES (
        ${taskId}, ${normalizeSkillName(input.skillName)}, ${input.projectId}, ${input.promptType},
        ${input.prompt}, ${input.rubric}, ${input.expectation}, ${input.baseRef},
        ${input.sourceRunId}, ${now}, NULL
      )
    `;
    return yield* loadTask(taskId);
  });

  const promotedPrompt = Effect.fn("SkillEvalService.promotedPrompt")(function* (input: {
    readonly runId: RunId;
    readonly projectId: ProjectId;
  }) {
    const rows = yield* sql<PromotedTurnRow>`
      SELECT thread.project_id, message.payload_json
      FROM orchestration_v2_projection_runs AS run
      JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = run.thread_id
      JOIN orchestration_v2_projection_messages AS message
        ON message.message_id = json_extract(run.payload_json, '$.userMessageId')
      WHERE run.run_id = ${input.runId}
        AND message.role = 'user'
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) {
      return yield* new SkillEvalValidationError({
        message: `Run '${input.runId}' has no promotable user message.`,
      });
    }
    if (row.project_id !== input.projectId) {
      return yield* new SkillEvalValidationError({
        message: "The promoted turn does not belong to the selected project.",
      });
    }
    return (yield* decodeConversationMessage(row.payload_json)).text;
  });

  const mutateTask = Effect.fn("SkillEvalService.mutateTask")(function* (
    input: SkillEvalTaskMutateInput,
  ) {
    switch (input.action) {
      case "add":
        return yield* insertTask({
          skillName: input.skillName,
          projectId: input.projectId,
          promptType: input.promptType,
          prompt: input.prompt,
          rubric: input.rubric,
          expectation: input.expectation ?? "either",
          baseRef: input.baseRef ?? null,
          sourceRunId: null,
        });
      case "promote-turn":
        return yield* insertTask({
          skillName: input.skillName,
          projectId: input.projectId,
          promptType: input.promptType,
          prompt: yield* promotedPrompt(input),
          rubric: input.rubric,
          expectation: input.expectation ?? "either",
          baseRef: input.baseRef ?? null,
          sourceRunId: input.runId,
        });
      case "update": {
        const current = yield* loadTask(input.taskId);
        yield* sql`
          UPDATE skill_eval_tasks
          SET prompt_type = ${input.promptType ?? current.promptType},
              prompt = ${input.prompt ?? current.prompt},
              rubric = ${input.rubric ?? current.rubric},
              expectation = ${input.expectation ?? current.expectation},
              base_ref = ${input.baseRef === undefined ? current.baseRef : input.baseRef}
          WHERE task_id = ${input.taskId}
        `;
        return yield* loadTask(input.taskId);
      }
      case "archive": {
        const current = yield* loadTask(input.taskId);
        if (current.archivedAt !== null) {
          return yield* new SkillEvalValidationError({ message: "The task is already archived." });
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`UPDATE skill_eval_tasks SET archived_at = ${now} WHERE task_id = ${input.taskId}`;
        return yield* loadTask(input.taskId);
      }
      case "restore": {
        const current = yield* loadTask(input.taskId);
        if (current.archivedAt === null) {
          return yield* new SkillEvalValidationError({ message: "The task is already active." });
        }
        yield* sql`UPDATE skill_eval_tasks SET archived_at = NULL WHERE task_id = ${input.taskId}`;
        return yield* loadTask(input.taskId);
      }
    }
  });

  const validateAndFreezeConfig = Effect.fn("SkillEvalService.validateAndFreezeConfig")(function* (
    input: SkillEvalRunConfig,
  ) {
    const skillName = normalizeSkillName(input.skillName);
    const controls = input.arms.filter((arm) => arm.role === "control");
    if (controls.length !== 1) {
      return yield* new SkillEvalValidationError({
        message: "An evaluation run must have exactly one control arm.",
      });
    }
    if (new Set(input.arms.map((arm) => arm.armId)).size !== input.arms.length) {
      return yield* new SkillEvalValidationError({ message: "Evaluation arm ids must be unique." });
    }

    const project = yield* projectFor(input.projectId);
    const providerSnapshots = yield* providers.getProviders;
    const candidate = providerSnapshots.find(
      (provider) => provider.instanceId === input.candidate.instanceId,
    );
    if (candidate === undefined) {
      return yield* new SkillEvalValidationError({
        message: `Candidate provider instance '${input.candidate.instanceId}' was not found.`,
      });
    }
    const settings = yield* serverSettings.getSettings;
    if (
      !candidate.enabled ||
      !resolveProjectProviderInstanceEnabled(settings, input.projectId, candidate.instanceId)
    ) {
      return yield* new SkillEvalValidationError({
        message: `Candidate provider instance '${candidate.instanceId}' is not enabled for this project.`,
      });
    }
    if (
      !candidate.installed ||
      candidate.status !== "ready" ||
      candidate.auth.status === "unauthenticated" ||
      !isProviderAvailable(candidate)
    ) {
      return yield* new SkillEvalValidationError({
        message: `Candidate provider instance '${candidate.instanceId}' is not ready.`,
      });
    }
    if (!candidate.models.some((model) => model.slug === input.candidate.model)) {
      return yield* new SkillEvalValidationError({
        message: `Candidate provider instance '${candidate.instanceId}' does not advertise model '${input.candidate.model}'.`,
      });
    }
    const capabilities = yield* (
      providerAdapters.getMetadata === undefined
        ? providerAdapters
            .get(candidate.instanceId)
            .pipe(Effect.flatMap((adapter) => adapter.getCapabilities()))
        : providerAdapters
            .getMetadata(candidate.instanceId)
            .pipe(Effect.map((metadata) => metadata.capabilities))
    ).pipe(
      Effect.mapError(
        () =>
          new SkillEvalValidationError({
            message: `Candidate provider instance '${candidate.instanceId}' capabilities could not be loaded.`,
          }),
      ),
    );
    if (capabilities.skillVariantDelivery === "unsupported") {
      return yield* new SkillEvalValidationError({
        message: `Candidate provider instance '${candidate.instanceId}' does not support skill policy delivery.`,
      });
    }

    const taskRows = yield* sql<SkillEvalTaskRow>`
        SELECT task_id, skill_name, project_id, prompt_type, prompt, rubric, expectation,
               base_ref, source_run_id, created_at, archived_at
        FROM skill_eval_tasks
        WHERE skill_name = ${skillName}
          AND project_id = ${input.projectId}
          AND archived_at IS NULL
        ORDER BY created_at ASC, task_id ASC
      `;
    const activeTasks = yield* Effect.forEach(taskRows, taskFromRow, { concurrency: 1 });
    const selectedTasks =
      input.taskIds.length === 0
        ? activeTasks
        : input.taskIds.map((taskId) => activeTasks.find((task) => task.taskId === taskId));
    if (selectedTasks.length === 0) {
      return yield* new SkillEvalValidationError({
        message: "Select at least one active task for this skill and project.",
      });
    }
    if (selectedTasks.some((task) => task === undefined)) {
      return yield* new SkillEvalValidationError({
        message: "Every selected task must be active and belong to this skill and project.",
      });
    }
    const tasks = selectedTasks.filter((task): task is SkillEvalTask => task !== undefined);
    const taskIds = tasks.map((task) => task.taskId);
    if (new Set(taskIds).size !== taskIds.length) {
      return yield* new SkillEvalValidationError({
        message: "Evaluation task ids must be unique.",
      });
    }
    const taskSnapshots = yield* Effect.forEach(
      tasks,
      (task) =>
        git
          .resolveCommit({
            cwd: project.workspaceRoot,
            revision: task.baseRef ?? "HEAD",
          })
          .pipe(
            Effect.map(({ commitSha }) => ({
              taskId: task.taskId,
              promptType: task.promptType,
              prompt: task.prompt,
              rubric: task.rubric,
              expectation: task.expectation,
              baseCommit: commitSha,
            })),
            Effect.mapError(
              () =>
                new SkillEvalValidationError({
                  message: `Task '${task.taskId}' base ref '${task.baseRef ?? "HEAD"}' does not resolve to a commit.`,
                }),
            ),
          ),
      { concurrency: 1 },
    );

    const variantRevisions: Record<string, number> = {};
    for (const arm of input.arms) {
      if (arm.kind === "variant" && arm.ruleId === undefined) {
        return yield* new SkillEvalValidationError({
          message: `Variant arm '${arm.label}' must select a variant rule.`,
        });
      }
      if (arm.kind === "base" && arm.ruleId !== undefined) {
        return yield* new SkillEvalValidationError({
          message: `Base arm '${arm.label}' cannot select a rule.`,
        });
      }
      if (arm.ruleId === undefined) continue;
      const requestedRevision = input.variantRevisions[arm.ruleId];
      const rows = yield* sql<VariantRevisionRow>`
          SELECT revision.rule_id AS rule_id, revision.revision AS revision
          FROM skill_variant_revisions AS revision
          JOIN skill_variant_rules AS rule ON rule.rule_id = revision.rule_id
          WHERE revision.rule_id = ${arm.ruleId}
            AND rule.skill_name = ${skillName}
            AND revision.mode = ${arm.kind}
            AND (${arm.kind} != 'variant' OR revision.body IS NOT NULL)
            AND (${requestedRevision ?? null} IS NULL OR revision.revision = ${requestedRevision ?? null})
          ORDER BY revision.revision DESC
          LIMIT 1
        `;
      if (rows[0] === undefined) {
        return yield* new SkillEvalValidationError({
          message: `${arm.kind === "variant" ? "Variant" : "Off"} arm '${arm.label}' does not have the requested frozen revision.`,
        });
      }
      variantRevisions[arm.ruleId] = rows[0].revision;
    }

    const judge = yield* resolveSkillEvalJudge({
      providers: providerSnapshots,
      explicit: input.judge,
      now: DateTime.toEpochMillis(yield* DateTime.now),
    });
    return SkillEvalRunConfig.make({
      ...input,
      skillName,
      taskIds,
      taskSnapshots,
      variantRevisions,
      judge: judge.modelSelection,
    });
  });

  const loadTrialRows = Effect.fn("SkillEvalService.loadTrialRows")(function* (
    evalRunId: SkillEvalRunId,
  ) {
    return yield* sql<SkillEvalTrialRow>`
      SELECT trial_id, eval_run_id, task_id, arm_id, repeat_index, thread_id, run_id,
             status, error, created_at, completed_at
      FROM skill_eval_trials
      WHERE eval_run_id = ${evalRunId}
      ORDER BY rowid ASC
    `;
  });

  const finalizeSkillUsage = Effect.fn("SkillEvalService.finalizeSkillUsage")(function* () {
    let finalized = FINALIZE_BATCH_SIZE;
    while (finalized === FINALIZE_BATCH_SIZE) {
      finalized = yield* skillUsage.finalizePending(FINALIZE_BATCH_SIZE);
    }
  });

  const assembleRun = Effect.fn("SkillEvalService.assembleRun")(function* (row: SkillEvalRunRow) {
    const config = yield* loadRunConfig(row);
    yield* finalizeSkillUsage();
    const trialRows = yield* loadTrialRows(SkillEvalRunId.make(row.eval_run_id));
    const trials = trialRows.map(trialFromRow);
    const taskMap = yield* taskSnapshotsFor(config);
    const judgmentRows = yield* sql<SkillEvalJudgmentRow>`
      SELECT judgment_id, eval_run_id, task_id, repeat_index, treatment_arm_id,
             control_arm_id, order_label, sample_index, preferred, treatment_score,
             control_score, rationale, judge_instance_id, judge_model, created_at
      FROM skill_eval_judgments
      WHERE eval_run_id = ${row.eval_run_id}
      ORDER BY task_id, repeat_index, treatment_arm_id, order_label, sample_index
    `.pipe(NodeSqliteClient.readOnly);
    const outcomeRows = yield* sql<SkillTurnOutcomeRow>`
      SELECT
        turn.eval_trial_id,
        turn.outcome_json,
        EXISTS (
          SELECT 1
          FROM skill_turn_evidence AS evidence
          WHERE evidence.run_id = turn.run_id
            AND lower(evidence.skill_name) = ${config.skillName}
            AND evidence.kind = 'activated'
        ) AS activated
      FROM skill_turns AS turn
      WHERE turn.eval_trial_id IN ${sql.in(trials.map((trial) => trial.trialId))}
    `.pipe(NodeSqliteClient.readOnly);
    const outcomeMap = new Map(
      outcomeRows.map(
        (outcome) => [SkillEvalTrialId.make(outcome.eval_trial_id), outcome] as const,
      ),
    );
    const snapshots = yield* providers.getProviders;
    const armResults = yield* assembleSkillEvalArmResults({
      row,
      config,
      trials,
      tasks: taskMap,
      judgments: judgmentRows,
      outcomes: outcomeMap,
      providers: snapshots,
    });
    return yield* decodeRunDetail({
      evalRunId: row.eval_run_id,
      skillName: row.skill_name,
      config,
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      armResults,
      trials,
    });
  });

  const getRun = Effect.fn("SkillEvalService.getRun")(function* (evalRunId: SkillEvalRunId) {
    return yield* assembleRun(yield* loadRunRow(evalRunId));
  });

  const listRuns = Effect.fn("SkillEvalService.listRuns")(function* (
    skillName: string,
    requestedLimit = DEFAULT_RUN_LIST_LIMIT,
  ) {
    const limit = Math.max(1, Math.trunc(requestedLimit));
    const rows = yield* sql<SkillEvalRunRow>`
      SELECT eval_run_id, skill_name, config_json, status, error, created_at, started_at, completed_at
      FROM skill_eval_runs
      WHERE skill_name = ${normalizeSkillName(skillName)}
      ORDER BY created_at DESC, eval_run_id DESC
      LIMIT ${limit}
    `.pipe(NodeSqliteClient.readOnly);
    return yield* Effect.forEach(
      rows,
      (row) => assembleRun(row).pipe(Effect.map(({ trials: _trials, ...summary }) => summary)),
      { concurrency: 1 },
    );
  });

  const latestVerdicts = Effect.fn("SkillEvalService.latestVerdicts")(function* (
    skillName: string,
  ) {
    const [snapshots, rows] = yield* Effect.all(
      [
        providers.getProviders,
        sql<SkillEvalRunRow>`
          WITH ranked AS (
            SELECT eval_run_id, skill_name, config_json, status, error, created_at, started_at,
                   completed_at,
                   ROW_NUMBER() OVER (
                     PARTITION BY json_extract(config_json, '$.candidate.instanceId'),
                                  lower(json_extract(config_json, '$.candidate.model'))
                     ORDER BY completed_at DESC, eval_run_id DESC
                   ) AS candidate_rank
            FROM skill_eval_runs
            WHERE skill_name = ${normalizeSkillName(skillName)}
              AND status = 'completed'
          )
          SELECT eval_run_id, skill_name, config_json, status, error, created_at, started_at,
                 completed_at
          FROM ranked
          WHERE candidate_rank = 1
          ORDER BY completed_at DESC, eval_run_id DESC
          LIMIT ${MAX_LATEST_VERDICTS}
        `.pipe(NodeSqliteClient.readOnly),
      ],
      { concurrency: 2 },
    );
    if (rows.length === 0) return [];

    const evalRunIds = rows.map((row) => SkillEvalRunId.make(row.eval_run_id));
    const [trialRows, judgmentRows] = yield* Effect.all(
      [
        sql<SkillEvalVerdictTrialRow>`
          SELECT eval_run_id, task_id, arm_id, repeat_index, status
          FROM skill_eval_trials
          WHERE eval_run_id IN ${sql.in(evalRunIds)}
        `.pipe(NodeSqliteClient.readOnly),
        sql<SkillEvalVerdictJudgmentRow>`
          SELECT eval_run_id, task_id, repeat_index, treatment_arm_id, order_label, sample_index,
                 preferred, treatment_score, control_score
          FROM skill_eval_judgments
          WHERE eval_run_id IN ${sql.in(evalRunIds)}
          ORDER BY task_id, repeat_index, treatment_arm_id, order_label, sample_index
        `.pipe(NodeSqliteClient.readOnly),
      ],
      { concurrency: 2 },
    );
    const trialsByRun = Map.groupBy(trialRows, (row) => row.eval_run_id);
    const judgmentsByRun = Map.groupBy(judgmentRows, (row) => row.eval_run_id);
    const seen = new Set<string>();
    const latest: LatestSkillEvalVerdict[] = [];
    for (const row of rows) {
      const config = yield* loadRunConfig(row);
      const provider = snapshots.find(
        (candidate) => candidate.instanceId === config.candidate.instanceId,
      );
      if (provider === undefined) continue;
      const key = `${provider.driver}\u0000${config.candidate.model.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      latest.push({
        driver: provider.driver,
        model: config.candidate.model,
        config,
        armVerdicts: assembleLatestSkillEvalArmVerdicts({
          config,
          trials: trialsByRun.get(row.eval_run_id) ?? [],
          judgments: judgmentsByRun.get(row.eval_run_id) ?? [],
        }),
      });
    }
    return latest;
  });

  const currentPendingRequest = Effect.fn("SkillEvalService.currentPendingRequest")(
    function* (input: { readonly projectId: ProjectId; readonly threadId: ThreadId }) {
      const records = yield* threadManagement.getProjectThreadRecords(input, ["runtimeRequests"]);
      return records.runtimeRequests.find(
        (request) =>
          request.status === "pending" &&
          (request.kind === "user_input" ||
            (request.kind !== "auth_refresh" && request.kind !== "dynamic_tool_call")),
      );
    },
  );

  const awaitTrial = Effect.fn("SkillEvalService.awaitTrial")(function* (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) {
    const afterSequence = yield* threadManagement.getThreadEventSequence(input.threadId);
    const current = yield* currentPendingRequest(input);
    if (current !== undefined) return { type: "request" as const, request: current };
    const request = threadManagement
      .streamStoredEventsFrom({
        threadId: input.threadId,
        afterSequence,
        eventType: "runtime-request.updated",
      })
      .pipe(
        Stream.mapEffect(() => currentPendingRequest(input)),
        Stream.filter(
          (candidate): candidate is OrchestrationV2RuntimeRequest => candidate !== undefined,
        ),
        Stream.runHead,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.never,
            onSome: (pending) => Effect.succeed({ type: "request" as const, request: pending }),
          }),
        ),
      );
    const terminal = threadManagement
      .waitForThread({
        projectId: input.projectId,
        threadId: input.threadId,
        runId: input.runId,
        timeoutMs: TRIAL_WAIT_TIMEOUT_MS,
      })
      .pipe(Effect.map((result) => ({ type: "terminal" as const, result })));
    return yield* Effect.raceFirst(terminal, request);
  });

  const archiveThread = Effect.fn("SkillEvalService.archiveThread")(function* (input: {
    readonly trialId: SkillEvalTrialId;
    readonly threadId: ThreadId;
  }) {
    yield* threadManagement
      .dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`skill-eval:${input.trialId}:${input.threadId}:archive`),
        threadId: input.threadId,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to archive a skill evaluation trial thread", {
            trialId: input.trialId,
            threadId: input.threadId,
            cause,
          }),
        ),
      );
  });

  const executeTrial = Effect.fn("SkillEvalService.executeTrial")(function* (input: {
    readonly evalRunId: SkillEvalRunId;
    readonly config: SkillEvalRunConfig;
    readonly task: SkillEvalTaskSnapshot;
    readonly trial: SkillEvalTrial;
    readonly arm: SkillEvalArm;
  }) {
    const threadId = yield* ids.allocate.thread({ projectId: input.config.projectId });
    const claimed = yield* sql<{ readonly trial_id: string }>`
      UPDATE skill_eval_trials
      SET thread_id = ${threadId}, run_id = NULL, status = 'running', error = NULL,
          completed_at = NULL
      WHERE trial_id = ${input.trial.trialId}
        AND status = 'pending'
      RETURNING trial_id
    `;
    if (claimed[0] === undefined) return yield* Effect.interrupt;
    const launch = yield* threadLaunch.launch({
      commandId: CommandId.make(`skill-eval:${input.trial.trialId}:${threadId}:launch`),
      threadId,
      projectId: input.config.projectId,
      title: `Skill eval · ${input.config.skillName} · ${input.arm.label} · ${input.task.taskId.slice(0, 8)}`,
      generateTitle: false,
      modelSelection: input.config.candidate,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: {
        type: "worktree",
        baseRef: input.task.baseCommit,
      },
      initialMessage: { text: input.task.prompt, attachments: [] },
      createdBy: "system",
      creationSource: "server",
    });
    const rootRun = launch.projection.runs.toSorted(
      (left, right) => right.ordinal - left.ordinal,
    )[0];
    if (rootRun === undefined) {
      return yield* new SkillEvalOperationError({
        operation: "launch trial",
        message: "The trial thread launched without a root run.",
      });
    }
    yield* sql`
      UPDATE skill_eval_trials
      SET run_id = ${rootRun.id}
      WHERE trial_id = ${input.trial.trialId}
    `;

    const awaited = yield* awaitTrial({
      projectId: input.config.projectId,
      threadId,
      runId: rootRun.id,
    });
    if (awaited.type === "request") {
      yield* threadManagement
        .interruptThread({
          projectId: input.config.projectId,
          commandId: CommandId.make(
            `skill-eval:${input.trial.trialId}:${threadId}:unattended-request`,
          ),
          threadId,
          runId: rootRun.id,
          reason: "Skill evaluation trials cannot wait for approvals or user input.",
        })
        .pipe(Effect.ignore);
      const completedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE skill_eval_trials
        SET status = 'failed',
            error = ${`Trial requested unattended ${awaited.request.kind}.`},
            completed_at = ${completedAt}
        WHERE trial_id = ${input.trial.trialId}
      `;
      yield* archiveThread({ trialId: input.trial.trialId, threadId });
      return;
    }

    const records = yield* threadManagement.getProjectThreadRecords(
      { projectId: input.config.projectId, threadId },
      ["turnItems"],
      { turnItemRunId: rootRun.id },
    );
    const requestedInteraction = records.turnItems.some(
      (item) => item.type === "approval_request" || item.type === "user_input_request",
    );
    const run = awaited.result.run;
    const completedAt = DateTime.formatIso(yield* DateTime.now);
    const completed =
      !awaited.result.timedOut && run?.status === "completed" && !requestedInteraction;
    const error = completed
      ? null
      : requestedInteraction
        ? "Trial requested an approval or user input."
        : awaited.result.timedOut
          ? "Trial did not reach a terminal state before the evaluation timeout."
          : `Trial run ended with status '${run?.status ?? "missing"}'.`;
    yield* sql`
      UPDATE skill_eval_trials
      SET status = ${completed ? "completed" : "failed"},
          error = ${error},
          completed_at = ${completedAt}
      WHERE trial_id = ${input.trial.trialId}
    `;
    yield* archiveThread({ trialId: input.trial.trialId, threadId });
  });

  const failTrial = Effect.fn("SkillEvalService.failTrial")(function* (
    trial: SkillEvalTrial,
    cause: unknown,
  ) {
    const currentRun = yield* loadRunRow(trial.evalRunId);
    if (currentRun.status === "cancelled") return;
    const completedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      UPDATE skill_eval_trials
      SET status = 'failed', error = ${causeMessage(cause)}, completed_at = ${completedAt}
      WHERE trial_id = ${trial.trialId}
        AND status IN ('pending', 'running')
    `;
    const rows = yield* sql<SkillEvalTrialRow>`
      SELECT trial_id, eval_run_id, task_id, arm_id, repeat_index, thread_id, run_id,
             status, error, created_at, completed_at
      FROM skill_eval_trials
      WHERE trial_id = ${trial.trialId}
    `;
    const threadId = rows[0]?.thread_id;
    if (threadId !== null && threadId !== undefined) {
      yield* archiveThread({ trialId: trial.trialId, threadId: ThreadId.make(threadId) });
    }
  });

  const trialTranscript = Effect.fn("SkillEvalService.trialTranscript")(function* (input: {
    readonly projectId: ProjectId;
    readonly trial: SkillEvalTrial;
  }) {
    if (input.trial.threadId === null || input.trial.runId === null) {
      return {
        status: input.trial.status,
        finalMessage: input.trial.error ?? "The trial did not launch.",
        changedFiles: [],
        toolFailures: 0,
      };
    }
    return yield* threadManagement
      .getProjectThreadRecords(
        { projectId: input.projectId, threadId: input.trial.threadId },
        ["runs", "turnItems"],
        { runIds: [input.trial.runId], turnItemRunId: input.trial.runId },
      )
      .pipe(
        Effect.map((records) => {
          const run = records.runs.find((candidate) => candidate.id === input.trial.runId);
          return buildSkillTrialTranscript({
            status: run?.status ?? input.trial.status,
            turnItems: records.turnItems,
          });
        }),
        Effect.orElseSucceed(() => ({
          status: input.trial.status,
          finalMessage: input.trial.error ?? "The trial transcript is unavailable.",
          changedFiles: [],
          toolFailures: 0,
        })),
      );
  });

  const runJudgments = Effect.fn("SkillEvalService.runJudgments")(function* (input: {
    readonly evalRunId: SkillEvalRunId;
    readonly config: SkillEvalRunConfig;
    readonly tasks: ReadonlyMap<SkillEvalTaskId, SkillEvalTaskSnapshot>;
    readonly judge: ResolvedSkillEvalJudge;
    readonly cwd: string;
  }) {
    const trials = (yield* loadTrialRows(input.evalRunId)).map(trialFromRow);
    const byCell = new Map(
      trials.map(
        (trial) =>
          [`${trial.taskId}\u0000${trial.repeatIndex}\u0000${trial.armId}`, trial] as const,
      ),
    );
    const control = input.config.arms.find((arm) => arm.role === "control");
    if (control === undefined) {
      return yield* new SkillEvalValidationError({
        message: "An evaluation run must have exactly one control arm.",
      });
    }
    const existingRows = yield* sql<SkillEvalJudgmentRow>`
      SELECT judgment_id, eval_run_id, task_id, repeat_index, treatment_arm_id,
             control_arm_id, order_label, sample_index, preferred, treatment_score,
             control_score, rationale, judge_instance_id, judge_model, created_at
      FROM skill_eval_judgments
      WHERE eval_run_id = ${input.evalRunId}
    `;
    const existing = new Set(
      existingRows.map((row) =>
        [
          row.task_id,
          row.repeat_index,
          row.treatment_arm_id,
          row.control_arm_id,
          row.order_label,
          row.sample_index,
        ].join("\u0000"),
      ),
    );
    const transcriptCache = new Map<SkillEvalTrialId, TrialTranscript>();
    const transcriptFor = Effect.fn("SkillEvalService.transcriptFor")(function* (
      trial: SkillEvalTrial,
    ) {
      const cached = transcriptCache.get(trial.trialId);
      if (cached !== undefined) return cached;
      const transcript = yield* trialTranscript({ projectId: input.config.projectId, trial });
      transcriptCache.set(trial.trialId, transcript);
      return transcript;
    });

    for (const taskId of input.config.taskIds) {
      const task = input.tasks.get(taskId);
      if (task === undefined) continue;
      for (let repeatIndex = 0; repeatIndex < input.config.repeats; repeatIndex += 1) {
        const controlTrial = byCell.get(`${taskId}\u0000${repeatIndex}\u0000${control.armId}`);
        if (controlTrial === undefined) continue;
        for (const treatment of input.config.arms.filter((arm) => arm.role === "treatment")) {
          const treatmentTrial = byCell.get(
            `${taskId}\u0000${repeatIndex}\u0000${treatment.armId}`,
          );
          if (treatmentTrial === undefined) continue;
          const treatmentTranscript = yield* transcriptFor(treatmentTrial);
          const controlTranscript = yield* transcriptFor(controlTrial);
          for (const orderLabel of ["treatment-first", "control-first"] as const) {
            for (let sampleIndex = 0; sampleIndex < input.config.judgeSamples; sampleIndex += 1) {
              const key = [
                taskId,
                repeatIndex,
                treatment.armId,
                control.armId,
                orderLabel,
                sampleIndex,
              ].join("\u0000");
              if (existing.has(key)) continue;
              const treatmentFirst = orderLabel === "treatment-first";
              const judgment = yield* textGeneration.judgeSkillTrial({
                cwd: input.cwd,
                modelSelection: input.judge.modelSelection,
                taskPrompt: task.prompt,
                rubric: task.rubric,
                responseA: treatmentFirst ? treatmentTranscript : controlTranscript,
                responseB: treatmentFirst ? controlTranscript : treatmentTranscript,
              });
              const mapped = mapPositionalSkillTrialJudgment(orderLabel, judgment);
              const now = DateTime.formatIso(yield* DateTime.now);
              yield* sql`
                INSERT OR IGNORE INTO skill_eval_judgments (
                  judgment_id, eval_run_id, task_id, repeat_index, treatment_arm_id,
                  control_arm_id, order_label, sample_index, preferred, treatment_score,
                  control_score, rationale, judge_instance_id, judge_model, created_at
                ) VALUES (
                  ${yield* randomUuidV4}, ${input.evalRunId}, ${taskId}, ${repeatIndex},
                  ${treatment.armId}, ${control.armId}, ${orderLabel}, ${sampleIndex},
                  ${mapped.preferred}, ${mapped.treatmentScore}, ${mapped.controlScore},
                  ${mapped.rationale}, ${input.judge.modelSelection.instanceId},
                  ${input.judge.modelSelection.model}, ${now}
                )
              `;
              existing.add(key);
            }
          }
        }
      }
    }
  });

  const cleanupTrialWorktree = Effect.fn("SkillEvalService.cleanupTrialWorktree")(
    function* (input: {
      readonly trial: SkillEvalTrial;
      readonly projectId: ProjectId;
      readonly projectRoot: string;
    }) {
      if (input.trial.threadId === null) return;
      const path = yield* threadManagement
        .getProjectThreadRecords({ projectId: input.projectId, threadId: input.trial.threadId }, [
          "runs",
        ])
        .pipe(
          Effect.map((records) => records.thread.worktreePath),
          Effect.orElseSucceed(() => null),
        );
      if (path === null) return;
      yield* gitWorkflow.removeWorktree({ cwd: input.projectRoot, path, force: true }).pipe(
        Effect.andThen(
          threadManagement
            .dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make(
                `skill-eval:${input.trial.trialId}:${input.trial.threadId}:cleanup-worktree`,
              ),
              threadId: input.trial.threadId,
              branch: null,
              worktreePath: null,
            })
            .pipe(Effect.ignore),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to remove a skill evaluation trial worktree", {
            evalRunId: input.trial.evalRunId,
            trialId: input.trial.trialId,
            path,
            cause,
          }),
        ),
      );
    },
  );

  const cleanupTrialWorktrees = Effect.fn("SkillEvalService.cleanupTrialWorktrees")(
    function* (input: {
      readonly evalRunId: SkillEvalRunId;
      readonly projectId: ProjectId;
      readonly projectRoot: string;
    }) {
      const trials = (yield* loadTrialRows(input.evalRunId)).map(trialFromRow);
      yield* Effect.forEach(trials, (trial) => cleanupTrialWorktree({ trial, ...input }), {
        concurrency: 1,
        discard: true,
      });
    },
  );

  const ensureRunMayProceed = Effect.fn("SkillEvalService.ensureRunMayProceed")(function* (
    evalRunId: SkillEvalRunId,
  ) {
    const row = yield* loadRunRow(evalRunId);
    if (row.status === "cancelled") return yield* Effect.interrupt;
    return row;
  });

  const executeRun = Effect.fn("SkillEvalService.executeRun")(function* (
    evalRunId: SkillEvalRunId,
  ) {
    const row = yield* ensureRunMayProceed(evalRunId);
    const config = yield* loadRunConfig(row);
    const project = yield* projectFor(config.projectId);
    const snapshots = yield* providers.getProviders;
    const judge = yield* resolveSkillEvalJudge({
      providers: snapshots,
      explicit: config.judge,
      now: DateTime.toEpochMillis(yield* DateTime.now),
    });
    const startedAt = row.started_at ?? DateTime.formatIso(yield* DateTime.now);
    const started = yield* sql<ActiveRunRow>`
      UPDATE skill_eval_runs
      SET status = 'running', error = NULL, started_at = ${startedAt}, completed_at = NULL
      WHERE eval_run_id = ${evalRunId}
        AND status = 'queued'
      RETURNING eval_run_id
    `;
    if (started[0] === undefined) return yield* Effect.interrupt;

    const tasks = yield* taskSnapshotsFor(config);
    const pending = (yield* loadTrialRows(evalRunId))
      .map(trialFromRow)
      .filter((trial) => trial.status === "pending");
    yield* Effect.forEach(
      pending,
      (trial) => {
        const task = tasks.get(trial.taskId);
        const arm = config.arms.find((candidate) => candidate.armId === trial.armId);
        if (task === undefined || arm === undefined) {
          return failTrial(trial, "The trial task or arm is missing from the frozen run config.");
        }
        return executeTrial({ evalRunId, config, task, trial, arm }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : failTrial(trial, Cause.squash(cause)),
          ),
        );
      },
      { concurrency: config.concurrency, discard: true },
    );

    const judging = yield* sql<ActiveRunRow>`
      UPDATE skill_eval_runs
      SET status = 'judging'
      WHERE eval_run_id = ${evalRunId}
        AND status = 'running'
      RETURNING eval_run_id
    `;
    if (judging[0] === undefined) return yield* Effect.interrupt;
    yield* runJudgments({
      evalRunId,
      config,
      tasks,
      judge,
      cwd: project.workspaceRoot,
    });
    yield* ensureRunMayProceed(evalRunId);
    yield* cleanupTrialWorktrees({
      evalRunId,
      projectId: config.projectId,
      projectRoot: project.workspaceRoot,
    });
    yield* finalizeSkillUsage();
    const completedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      UPDATE skill_eval_runs
      SET status = 'completed', error = NULL, completed_at = ${completedAt}
      WHERE eval_run_id = ${evalRunId}
        AND status = 'judging'
    `;
  });

  const markRunFailed = Effect.fn("SkillEvalService.markRunFailed")(function* (
    evalRunId: SkillEvalRunId,
    cause: unknown,
  ) {
    const completedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      UPDATE skill_eval_runs
      SET status = 'failed', error = ${causeMessage(cause)}, completed_at = ${completedAt}
      WHERE eval_run_id = ${evalRunId}
        AND status IN ('queued', 'running', 'judging')
      RETURNING eval_run_id
    `;
    const config = yield* loadRunConfig(yield* loadRunRow(evalRunId));
    yield* Effect.gen(function* () {
      const project = yield* projectFor(config.projectId);
      yield* cleanupTrialWorktrees({
        evalRunId,
        projectId: config.projectId,
        projectRoot: project.workspaceRoot,
      });
    }).pipe(
      Effect.catchCause((cleanupCause) =>
        Effect.logWarning("Failed to clean skill evaluation worktrees", {
          evalRunId,
          cause: cleanupCause,
        }),
      ),
    );
  });

  const spawnRun = Effect.fn("SkillEvalService.spawnRun")(function* (evalRunId: SkillEvalRunId) {
    const program = executeRun(evalRunId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : markRunFailed(evalRunId, Cause.squash(cause)).pipe(Effect.catchCause(Effect.logError)),
      ),
      Effect.ensuring(
        Ref.update(fibers, (current) => {
          const next = new Map(current);
          next.delete(evalRunId);
          return next;
        }),
      ),
    );
    const fiber = yield* program.pipe(Effect.forkIn(scope));
    yield* Ref.update(fibers, (current) => new Map(current).set(evalRunId, fiber));
  });

  const assertNoOtherActiveRun = Effect.fn("SkillEvalService.assertNoOtherActiveRun")(function* (
    except?: SkillEvalRunId,
  ) {
    const rows = yield* sql<ActiveRunRow>`
        SELECT eval_run_id
        FROM skill_eval_runs
        WHERE status IN ('queued', 'running', 'judging')
          AND (${except ?? null} IS NULL OR eval_run_id <> ${except ?? null})
        LIMIT 1
      `;
    if (rows[0] !== undefined) {
      return yield* new SkillEvalValidationError({
        message: `Evaluation run '${rows[0].eval_run_id}' is already active. Wait for it or cancel it before starting another.`,
      });
    }
  });

  const start = Effect.fn("SkillEvalService.start")(function* (input: SkillEvalRunConfig) {
    const config = yield* validateAndFreezeConfig(input);
    const evalRunId = SkillEvalRunId.make(yield* randomUuidV4);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const cells = buildSkillEvalTrialCells({
      evalRunId,
      taskIds: config.taskIds,
      arms: config.arms,
      repeats: config.repeats,
    });
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertNoOtherActiveRun();
        yield* sql`
          INSERT INTO skill_eval_runs (
            eval_run_id, skill_name, config_json, status, error, created_at, started_at, completed_at
          ) VALUES (
            ${evalRunId}, ${config.skillName}, ${encodeRunConfig(config)}, 'queued', NULL,
            ${createdAt}, NULL, NULL
          )
        `;
        for (const cell of cells) {
          yield* sql`
            INSERT INTO skill_eval_trials (
              trial_id, eval_run_id, task_id, arm_id, repeat_index, thread_id, run_id,
              status, error, created_at, completed_at
            ) VALUES (
              ${yield* randomUuidV4}, ${evalRunId}, ${cell.taskId}, ${cell.armId},
              ${cell.repeatIndex}, NULL, NULL, 'pending', NULL, ${createdAt}, NULL
            )
          `;
        }
      }),
    );
    yield* spawnRun(evalRunId);
    const { trials: _trials, ...summary } = yield* getRun(evalRunId);
    return summary;
  });

  const interruptTrialThreads = Effect.fn("SkillEvalService.interruptTrialThreads")(
    function* (input: { readonly evalRunId: SkillEvalRunId; readonly projectId: ProjectId }) {
      const trials = (yield* loadTrialRows(input.evalRunId)).map(trialFromRow);
      yield* Effect.forEach(
        trials.filter(
          (trial) =>
            trial.threadId !== null && (trial.status === "running" || trial.status === "cancelled"),
        ),
        (trial) =>
          threadManagement
            .interruptThread({
              projectId: input.projectId,
              commandId: CommandId.make(`skill-eval:${trial.trialId}:${trial.threadId}:cancel`),
              threadId: trial.threadId as ThreadId,
              ...(trial.runId === null ? {} : { runId: trial.runId }),
              reason: "Skill evaluation run cancelled.",
            })
            .pipe(
              Effect.ignore,
              Effect.andThen(
                archiveThread({ trialId: trial.trialId, threadId: trial.threadId as ThreadId }),
              ),
            ),
        { concurrency: "unbounded", discard: true },
      );
    },
  );

  const cancel = Effect.fn("SkillEvalService.cancel")(function* (evalRunId: SkillEvalRunId) {
    const row = yield* loadRunRow(evalRunId);
    const config = yield* loadRunConfig(row);
    const now = DateTime.formatIso(yield* DateTime.now);
    const cancelled = yield* sql.withTransaction(
      Effect.gen(function* () {
        const updated = yield* sql`
          UPDATE skill_eval_runs
          SET status = 'cancelled', error = NULL, completed_at = ${now}
          WHERE eval_run_id = ${evalRunId}
            AND status IN ('queued', 'running', 'judging', 'interrupted')
          RETURNING eval_run_id
        `;
        if (updated.length === 0) return false;
        yield* sql`
          UPDATE skill_eval_trials
          SET status = 'cancelled', error = 'Evaluation run cancelled.', completed_at = ${now}
          WHERE eval_run_id = ${evalRunId}
            AND status IN ('pending', 'running')
        `;
        return true;
      }),
    );
    if (cancelled) {
      const fiber = (yield* Ref.get(fibers)).get(evalRunId);
      if (fiber !== undefined) yield* Fiber.interrupt(fiber);
      yield* interruptTrialThreads({ evalRunId, projectId: config.projectId });
      const project = yield* projectFor(config.projectId);
      yield* cleanupTrialWorktrees({
        evalRunId,
        projectId: config.projectId,
        projectRoot: project.workspaceRoot,
      });
    }
    const { trials: _trials, ...summary } = yield* getRun(evalRunId);
    return summary;
  });

  const resume = Effect.fn("SkillEvalService.resume")(function* (evalRunId: SkillEvalRunId) {
    const row = yield* loadRunRow(evalRunId);
    if (
      row.status === "completed" ||
      row.status === "queued" ||
      row.status === "running" ||
      row.status === "judging"
    ) {
      return yield* new SkillEvalValidationError({
        message: `Evaluation run '${evalRunId}' cannot be resumed from status '${row.status}'.`,
      });
    }
    const config = yield* loadRunConfig(row);
    const snapshots = yield* providers.getProviders;
    yield* resolveSkillEvalJudge({
      providers: snapshots,
      explicit: config.judge,
      now: DateTime.toEpochMillis(yield* DateTime.now),
    });
    const project = yield* projectFor(config.projectId);
    const incompleteTrials = (yield* loadTrialRows(evalRunId))
      .map(trialFromRow)
      .filter((trial) => trial.status === "running" || trial.status === "cancelled");
    yield* interruptTrialThreads({ evalRunId, projectId: config.projectId });
    yield* Effect.forEach(
      incompleteTrials,
      (trial) =>
        cleanupTrialWorktree({
          trial,
          projectId: config.projectId,
          projectRoot: project.workspaceRoot,
        }),
      { concurrency: 1, discard: true },
    );
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertNoOtherActiveRun(evalRunId);
        yield* sql`
          UPDATE skill_eval_trials
          SET status = 'pending', thread_id = NULL, run_id = NULL, error = NULL, completed_at = NULL
          WHERE eval_run_id = ${evalRunId}
            AND status IN ('running', 'cancelled')
        `;
        yield* sql`
          UPDATE skill_eval_runs
          SET status = 'queued', error = NULL, completed_at = NULL
          WHERE eval_run_id = ${evalRunId}
        `;
      }),
    );
    yield* spawnRun(evalRunId);
    const { trials: _trials, ...summary } = yield* getRun(evalRunId);
    return summary;
  });

  const control = Effect.fn("SkillEvalService.control")(function* (
    input: SkillEvalRunControlInput,
  ) {
    switch (input.action) {
      case "start":
        return yield* start(input.config);
      case "cancel":
        return yield* cancel(input.evalRunId);
      case "resume":
        return yield* resume(input.evalRunId);
    }
  });

  return SkillEvalService.of({
    listTasks: Effect.fn("SkillEvalService.listTasks.public")((input) =>
      listTasks(input).pipe(
        Effect.mapError((cause) => preserveEvalError("list eval tasks", cause)),
      ),
    ),
    mutateTask: Effect.fn("SkillEvalService.mutateTask.public")((input) =>
      mutateTask(input).pipe(
        Effect.mapError((cause) => preserveEvalError("mutate eval task", cause)),
      ),
    ),
    start: Effect.fn("SkillEvalService.start.public")((config) =>
      start(config).pipe(Effect.mapError((cause) => preserveEvalError("start eval run", cause))),
    ),
    cancel: Effect.fn("SkillEvalService.cancel.public")((evalRunId) =>
      cancel(evalRunId).pipe(
        Effect.mapError((cause) => preserveEvalError("cancel eval run", cause)),
      ),
    ),
    resume: Effect.fn("SkillEvalService.resume.public")((evalRunId) =>
      resume(evalRunId).pipe(
        Effect.mapError((cause) => preserveEvalError("resume eval run", cause)),
      ),
    ),
    control: Effect.fn("SkillEvalService.control.public")((input) =>
      control(input).pipe(Effect.mapError((cause) => preserveEvalError("control eval run", cause))),
    ),
    getRun: Effect.fn("SkillEvalService.getRun.public")((evalRunId) =>
      getRun(evalRunId).pipe(Effect.mapError((cause) => preserveEvalError("read eval run", cause))),
    ),
    listRuns: Effect.fn("SkillEvalService.listRuns.public")((skillName, limit) =>
      listRuns(skillName, limit).pipe(
        Effect.mapError((cause) => preserveEvalError("list eval runs", cause)),
      ),
    ),
    latestVerdicts: Effect.fn("SkillEvalService.latestVerdicts.public")((skillName) =>
      latestVerdicts(skillName).pipe(
        Effect.mapError((cause) => preserveEvalError("read latest eval verdicts", cause)),
      ),
    ),
  });
});

export const layer = Layer.effect(SkillEvalService, make);
