import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { DEFAULT_GIT_TEXT_GENERATION_MODEL } from "./model.ts";
import { ModelSelection } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const AutoReviewMode = Schema.Literals(["auto", "mention"]);
export type AutoReviewMode = typeof AutoReviewMode.Type;

/**
 * Which model runs the auto-fix turn on the origin thread.
 *
 * - `thread` — no override: the thread keeps whatever model it was using, so
 *   the agent that wrote the code also fixes it (the v1 behaviour).
 * - `review` — reuse the reviewer's model, so the model that raised the
 *   findings is the one that acts on them.
 * - `custom` — an explicit `fixModelSelection`, letting a cheap reviewer hand
 *   off to a stronger fixer (or the reverse).
 */
export const AutoReviewFixModelMode = Schema.Literals(["thread", "review", "custom"]);
export type AutoReviewFixModelMode = typeof AutoReviewFixModelMode.Type;

export const AutoReviewProjectOverride = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  mode: Schema.optional(AutoReviewMode),
  modelSelection: Schema.optional(ModelSelection),
  autoFixOriginThread: Schema.optional(Schema.Boolean),
  fixModelMode: Schema.optional(AutoReviewFixModelMode),
  fixModelSelection: Schema.optional(ModelSelection),
  mentionHandle: Schema.optional(TrimmedNonEmptyString),
});
export type AutoReviewProjectOverride = typeof AutoReviewProjectOverride.Type;

export const DEFAULT_AUTO_REVIEW_POLL_INTERVAL = Duration.seconds(60);
export const DEFAULT_AUTO_REVIEW_MAX_DIFF_BYTES = 400_000;
/**
 * Total attempts (initial run + retries) for a single PR head SHA before the
 * auto-reviewer gives up. Guards against models that keep failing (e.g.
 * invalid structured output) burning tokens on every poll tick.
 */
export const DEFAULT_AUTO_REVIEW_MAX_ATTEMPTS = 2;
/**
 * Reviews run concurrently across distinct PRs. One PR is never reviewed by
 * two jobs at once, so this only widens the fan-out when several PRs are open.
 */
export const DEFAULT_AUTO_REVIEW_CONCURRENCY = 1;
/** Auto-fix turns dispatched concurrently, across distinct origin threads. */
export const DEFAULT_AUTO_REVIEW_FIX_CONCURRENCY = 1;

export const AutoReviewSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  mode: AutoReviewMode.pipe(Schema.withDecodingDefault(Effect.succeed("auto" as const))),
  modelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
      }),
    ),
  ),
  mentionHandle: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed("surgecode")),
  ),
  pollInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_AUTO_REVIEW_POLL_INTERVAL)),
    ),
  ),
  autoFixOriginThread: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  fixModelMode: AutoReviewFixModelMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("thread" as const)),
  ),
  /** Only consulted when `fixModelMode` is `custom`. */
  fixModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  maxAttempts: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AUTO_REVIEW_MAX_ATTEMPTS)),
  ),
  maxDiffBytes: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AUTO_REVIEW_MAX_DIFF_BYTES)),
  ),
  concurrency: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AUTO_REVIEW_CONCURRENCY)),
  ),
  fixConcurrency: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AUTO_REVIEW_FIX_CONCURRENCY)),
  ),
  projects: Schema.Record(ProjectId, AutoReviewProjectOverride).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type AutoReviewSettings = typeof AutoReviewSettings.Type;

export const DEFAULT_AUTO_REVIEW_SETTINGS: AutoReviewSettings = Schema.decodeSync(
  AutoReviewSettings,
)({});

export const AutoReviewSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  mode: Schema.optionalKey(AutoReviewMode),
  modelSelection: Schema.optionalKey(ModelSelection),
  mentionHandle: Schema.optionalKey(TrimmedNonEmptyString),
  pollInterval: Schema.optionalKey(Schema.DurationFromMillis),
  autoFixOriginThread: Schema.optionalKey(Schema.Boolean),
  fixModelMode: Schema.optionalKey(AutoReviewFixModelMode),
  fixModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  maxAttempts: Schema.optionalKey(PositiveInt),
  maxDiffBytes: Schema.optionalKey(PositiveInt),
  concurrency: Schema.optionalKey(PositiveInt),
  fixConcurrency: Schema.optionalKey(PositiveInt),
  // Whole-map replacement for per-project overrides.
  projects: Schema.optionalKey(Schema.Record(ProjectId, AutoReviewProjectOverride)),
});
export type AutoReviewSettingsPatch = typeof AutoReviewSettingsPatch.Type;

export const AutoReviewSeverity = Schema.Literals(["blocking", "important", "nit", "info"]);
export type AutoReviewSeverity = typeof AutoReviewSeverity.Type;

export const AutoReviewDiffSide = Schema.Literals(["LEFT", "RIGHT"]);
export type AutoReviewDiffSide = typeof AutoReviewDiffSide.Type;

export const AutoReviewDecision = Schema.Literals(["comment", "request_changes", "approve"]);
export type AutoReviewDecision = typeof AutoReviewDecision.Type;

export const AutoReviewInlineComment = Schema.Struct({
  path: TrimmedNonEmptyString,
  line: Schema.NullOr(PositiveInt),
  side: Schema.NullOr(AutoReviewDiffSide),
  severity: AutoReviewSeverity,
  body: Schema.String,
});
export type AutoReviewInlineComment = typeof AutoReviewInlineComment.Type;

export const AutoReviewFindings = Schema.Struct({
  summary: Schema.String,
  decision: AutoReviewDecision,
  comments: Schema.Array(AutoReviewInlineComment),
});
export type AutoReviewFindings = typeof AutoReviewFindings.Type;

export const AutoReviewJobStatus = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);
export type AutoReviewJobStatus = typeof AutoReviewJobStatus.Type;

export const AutoReviewTrigger = Schema.Literals(["open_or_push", "mention"]);
export type AutoReviewTrigger = typeof AutoReviewTrigger.Type;

export const AutoReviewJobId = TrimmedNonEmptyString;
export type AutoReviewJobId = typeof AutoReviewJobId.Type;

/**
 * A fix prompt the auto-reviewer could not dispatch yet because the origin
 * thread was busy. Drained (dispatched as a normal turn) once the thread goes
 * idle — auto-review never steers/injects into a running turn.
 */
export const AutoReviewPendingFix = Schema.Struct({
  threadId: ThreadId,
  prompt: Schema.String,
  /**
   * Model the fix turn must run under, or null to keep the thread's own
   * model. Carried on the parked fix so a drain minutes later still applies
   * the selection the review resolved.
   */
  modelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  queuedAt: IsoDateTime,
});
export type AutoReviewPendingFix = typeof AutoReviewPendingFix.Type;

export const AutoReviewJob = Schema.Struct({
  id: AutoReviewJobId,
  projectId: ProjectId,
  prNumber: PositiveInt,
  headSha: TrimmedNonEmptyString,
  /**
   * PR head branch captured at enqueue time. Lets the phase sync attribute a
   * queued/running job to its origin thread before the runner links it on
   * success, so the thread shows "reviewing" while the review is in flight.
   */
  headBranch: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  trigger: AutoReviewTrigger,
  commentId: Schema.optional(Schema.NullOr(TrimmedString)),
  status: AutoReviewJobStatus,
  /** 1-based attempt number for this (project, PR, headSha) review chain. */
  attempt: NonNegativeInt,
  modelSelection: ModelSelection,
  /**
   * Model resolved for the auto-fix turn at enqueue time, or null to leave the
   * origin thread on its own model. Frozen with the job so a settings change
   * mid-flight cannot retarget a review that is already running.
   */
  fixModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  findingsCount: Schema.optional(Schema.NullOr(NonNegativeInt)),
  reviewUrl: Schema.optional(Schema.NullOr(Schema.String)),
  githubReviewId: Schema.optional(Schema.NullOr(TrimmedString)),
  originThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  autoFixEnqueued: Schema.Boolean,
  /**
   * Queued auto-fix waiting for the origin thread to go idle. Set instead of
   * dispatching when the thread is busy; cleared once dispatched or dropped.
   */
  pendingFix: Schema.NullOr(AutoReviewPendingFix).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Review verdict produced by the reviewer, once the job succeeds. */
  decision: Schema.NullOr(AutoReviewDecision).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** True when the findings contained blocking/important comments. */
  actionableFindings: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  error: Schema.optional(Schema.NullOr(Schema.String)),
  skipReason: Schema.optional(Schema.NullOr(TrimmedString)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AutoReviewJob = typeof AutoReviewJob.Type;

export const ListAutoReviewJobsInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  limit: Schema.optional(PositiveInt),
});
export type ListAutoReviewJobsInput = typeof ListAutoReviewJobsInput.Type;

export const ListAutoReviewJobsResult = Schema.Struct({
  jobs: Schema.Array(AutoReviewJob),
});
export type ListAutoReviewJobsResult = typeof ListAutoReviewJobsResult.Type;

export const GetAutoReviewJobInput = Schema.Struct({
  id: AutoReviewJobId,
});
export type GetAutoReviewJobInput = typeof GetAutoReviewJobInput.Type;

export const GetAutoReviewJobResult = Schema.Struct({
  job: Schema.NullOr(AutoReviewJob),
});
export type GetAutoReviewJobResult = typeof GetAutoReviewJobResult.Type;
