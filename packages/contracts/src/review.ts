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

/** Live pull-request context gathered during the review: state, review
    verdict, CI, and whether the PR is mergeable as-is. */
export const ReviewThreadPrStatus = Schema.Struct({
  number: Schema.Int,
  url: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed", "merged"]),
  /** GitHub reviewDecision: APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED /
      empty (no required reviews). */
  reviewDecision: Schema.NullOr(TrimmedNonEmptyString),
  /** Rolled-up CI outcome for the head commit. */
  checksPassing: Schema.NullOr(Schema.Boolean),
  /** GitHub mergeable: whether the branch applies cleanly onto base. */
  mergeable: Schema.NullOr(Schema.Boolean),
  /** Open + clean merge + CI green + not blocked by requested changes. */
  mergeReady: Schema.Boolean,
  recentCommentCount: Schema.Int,
});
export type ReviewThreadPrStatus = typeof ReviewThreadPrStatus.Type;

export const ReviewThreadSummaryResult = Schema.Struct({
  threadId: ThreadId,
  summary: TrimmedNonEmptyString,
  /** One imperative sentence: the user's single next action. Optional for
      pre-nextStep servers. */
  nextStep: Schema.optionalKey(TrimmedNonEmptyString),
  /** Null when the current title is still accurate. */
  suggestedTitle: Schema.NullOr(TrimmedNonEmptyString),
  recommendSettle: Schema.Boolean,
  settleReason: Schema.NullOr(TrimmedNonEmptyString),
  /** Absent when the thread has no ready checkpoint (or pre-diff servers). */
  diffStats: Schema.optionalKey(ReviewThreadDiffStats),
  /** Absent when the thread has no PR, the lookup failed, or pre-PR servers. */
  prStatus: Schema.optionalKey(ReviewThreadPrStatus),
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

export const ReviewMergePullRequestInput = Schema.Struct({
  threadId: ThreadId,
  /** The PR number the client saw at review time; the server re-validates
      merge-readiness against live GitHub state before merging. */
  pullRequestNumber: Schema.Int,
});
export type ReviewMergePullRequestInput = typeof ReviewMergePullRequestInput.Type;

export const ReviewMergePullRequestResult = Schema.Struct({
  threadId: ThreadId,
  outcome: Schema.Literals([
    "merged",
    /** Branch no longer applies cleanly (e.g. an earlier queue merge landed
        first). The client hands the conflict to the thread's agent. */
    "conflict",
    /** PR already merged or closed since the review ran. */
    "already-closed",
    /** No longer merge-ready (CI regressed, review dismissed, ...). */
    "not-ready",
  ]),
  detail: Schema.NullOr(TrimmedNonEmptyString),
});
export type ReviewMergePullRequestResult = typeof ReviewMergePullRequestResult.Type;

export class ReviewMergeError extends Schema.TaggedErrorClass<ReviewMergeError>()(
  "ReviewMergeError",
  {
    threadId: ThreadId,
    detail: TrimmedNonEmptyString,
  },
) {}

export const ReviewMergePullRequestError = Schema.Union([
  ReviewThreadNotFoundError,
  ReviewMergeError,
]);
export type ReviewMergePullRequestError = typeof ReviewMergePullRequestError.Type;
