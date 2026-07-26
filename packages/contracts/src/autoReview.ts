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

export const AutoReviewProjectOverride = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  mode: Schema.optional(AutoReviewMode),
  modelSelection: Schema.optional(ModelSelection),
  autoFixOriginThread: Schema.optional(Schema.Boolean),
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
  maxAttempts: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AUTO_REVIEW_MAX_ATTEMPTS)),
  ),
  maxDiffBytes: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AUTO_REVIEW_MAX_DIFF_BYTES)),
  ),
  concurrency: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(1))),
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
  maxAttempts: Schema.optionalKey(PositiveInt),
  maxDiffBytes: Schema.optionalKey(PositiveInt),
  concurrency: Schema.optionalKey(PositiveInt),
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
  queuedAt: IsoDateTime,
});
export type AutoReviewPendingFix = typeof AutoReviewPendingFix.Type;

export const AutoReviewJob = Schema.Struct({
  id: AutoReviewJobId,
  projectId: ProjectId,
  prNumber: PositiveInt,
  headSha: TrimmedNonEmptyString,
  trigger: AutoReviewTrigger,
  commentId: Schema.optional(Schema.NullOr(TrimmedString)),
  status: AutoReviewJobStatus,
  /** 1-based attempt number for this (project, PR, headSha) review chain. */
  attempt: NonNegativeInt,
  modelSelection: ModelSelection,
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
