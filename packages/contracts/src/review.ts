import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitCommandError } from "./git.ts";
import { SourceControlProviderError, SourceControlProviderKind } from "./sourceControl.ts";
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

export const PullRequestReviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  reference: TrimmedNonEmptyString,
});
export type PullRequestReviewInput = typeof PullRequestReviewInput.Type;

export const PullRequestReviewAuthor = Schema.Struct({
  login: TrimmedNonEmptyString,
  avatarUrl: Schema.NullOr(Schema.String),
  isBot: Schema.Boolean,
});
export type PullRequestReviewAuthor = typeof PullRequestReviewAuthor.Type;

export const PullRequestReviewComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: PullRequestReviewAuthor,
  authorAssociation: Schema.NullOr(Schema.String),
  body: Schema.String,
  url: Schema.String,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
});
export type PullRequestReviewComment = typeof PullRequestReviewComment.Type;

export const PullRequestReviewSummary = Schema.Struct({
  ...PullRequestReviewComment.fields,
  state: TrimmedNonEmptyString,
});
export type PullRequestReviewSummary = typeof PullRequestReviewSummary.Type;

export const PullRequestReviewDiffSide = Schema.Literals(["LEFT", "RIGHT"]);
export type PullRequestReviewDiffSide = typeof PullRequestReviewDiffSide.Type;

export const PullRequestReviewThread = Schema.Struct({
  id: TrimmedNonEmptyString,
  isResolved: Schema.Boolean,
  isOutdated: Schema.Boolean,
  path: TrimmedNonEmptyString,
  line: Schema.NullOr(PositiveInt),
  originalLine: Schema.NullOr(PositiveInt),
  diffSide: Schema.NullOr(PullRequestReviewDiffSide),
  comments: Schema.Array(PullRequestReviewComment),
});
export type PullRequestReviewThread = typeof PullRequestReviewThread.Type;

/**
 * Provider-neutral snapshot of the discussion attached to a pull request.
 * `truncated` is true when any GitHub connection exceeded the bounded page
 * fetched by the server, so clients never mistake a partial snapshot for the
 * complete review.
 */
export const PullRequestReviewResult = Schema.Struct({
  provider: SourceControlProviderKind,
  number: PositiveInt,
  url: Schema.String,
  comments: Schema.Array(PullRequestReviewComment),
  reviews: Schema.Array(PullRequestReviewSummary),
  threads: Schema.Array(PullRequestReviewThread),
  unresolvedThreadCount: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type PullRequestReviewResult = typeof PullRequestReviewResult.Type;

export const PullRequestReviewError = Schema.Union([VcsError, SourceControlProviderError]);
export type PullRequestReviewError = typeof PullRequestReviewError.Type;
