import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitCommandError, TextGenerationError } from "./git.ts";
import { VcsError } from "./vcs.ts";

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewDiffPreviewSourceKind = Schema.Literals(["working-tree", "branch-range"]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

export const ReviewDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewDiffPreviewSourceKind,
  title: TrimmedNonEmptyString,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
});
export type ReviewDiffPreviewSource = typeof ReviewDiffPreviewSource.Type;

export const ReviewDiffPreviewResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(ReviewDiffPreviewSource),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;

export const ReviewThreadSummaryInput = Schema.Struct({
  threadId: ThreadId,
  /** Whether the thread is currently eligible to settle (no running session,
      pending approvals, or pending user input). The server never recommends
      settling when this is false, regardless of what the model says. */
  canSettleNow: Schema.Boolean,
});
export type ReviewThreadSummaryInput = typeof ReviewThreadSummaryInput.Type;

/** Size of the thread's latest ready checkpoint diff — a cheap effort proxy
    for the review UI ("how big is this thread's change"). */
export const ReviewThreadDiffStats = Schema.Struct({
  files: Schema.Int,
  additions: Schema.Int,
  deletions: Schema.Int,
});
export type ReviewThreadDiffStats = typeof ReviewThreadDiffStats.Type;

export const ReviewThreadSummaryResult = Schema.Struct({
  threadId: ThreadId,
  summary: TrimmedNonEmptyString,
  /** Null when the current title is still accurate. */
  suggestedTitle: Schema.NullOr(TrimmedNonEmptyString),
  recommendSettle: Schema.Boolean,
  settleReason: Schema.NullOr(TrimmedNonEmptyString),
  /** Absent when the thread has no ready checkpoint (or pre-diff servers). */
  diffStats: Schema.optionalKey(ReviewThreadDiffStats),
});
export type ReviewThreadSummaryResult = typeof ReviewThreadSummaryResult.Type;

export class ReviewThreadNotFoundError extends Schema.TaggedErrorClass<ReviewThreadNotFoundError>()(
  "ReviewThreadNotFoundError",
  { threadId: ThreadId },
) {}

export const ReviewThreadSummaryError = Schema.Union([
  TextGenerationError,
  ReviewThreadNotFoundError,
]);
export type ReviewThreadSummaryError = typeof ReviewThreadSummaryError.Type;
