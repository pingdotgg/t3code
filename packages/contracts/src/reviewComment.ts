import { Schema } from "effect";
import { PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

export const ReviewCommentSeverity = Schema.Literals(["info", "suggestion", "issue", "blocker"]);
export type ReviewCommentSeverity = typeof ReviewCommentSeverity.Type;

export const ReviewComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  file: TrimmedNonEmptyString,
  startLine: PositiveInt,
  endLine: Schema.optional(PositiveInt),
  body: TrimmedNonEmptyString,
  severity: ReviewCommentSeverity,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  publishedAt: Schema.optional(Schema.String),
  publishedUrl: Schema.optional(Schema.String),
});
export type ReviewComment = typeof ReviewComment.Type;

// ── WS Inputs ────────────────────────────────────────────────────────

export const ReviewCommentAddInput = Schema.Struct({
  threadId: ThreadId,
  file: TrimmedNonEmptyString,
  startLine: PositiveInt,
  endLine: Schema.optional(PositiveInt),
  body: TrimmedNonEmptyString,
  severity: ReviewCommentSeverity,
});
export type ReviewCommentAddInput = typeof ReviewCommentAddInput.Type;

export const ReviewCommentUpdateInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  body: Schema.optional(TrimmedNonEmptyString),
  severity: Schema.optional(ReviewCommentSeverity),
  publishedAt: Schema.optional(Schema.String),
  publishedUrl: Schema.optional(Schema.String),
});
export type ReviewCommentUpdateInput = typeof ReviewCommentUpdateInput.Type;

export const ReviewCommentDeleteInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type ReviewCommentDeleteInput = typeof ReviewCommentDeleteInput.Type;

export const ReviewCommentListInput = Schema.Struct({
  threadId: ThreadId,
});
export type ReviewCommentListInput = typeof ReviewCommentListInput.Type;

export const ReviewCommentPublishInput = Schema.Struct({
  threadId: ThreadId,
  cwd: TrimmedNonEmptyString,
  prUrl: TrimmedNonEmptyString,
  commentId: Schema.optional(TrimmedNonEmptyString),
});
export type ReviewCommentPublishInput = typeof ReviewCommentPublishInput.Type;

// ── WS Results ───────────────────────────────────────────────────────

export const ReviewCommentAddResult = Schema.Struct({
  comment: ReviewComment,
});
export type ReviewCommentAddResult = typeof ReviewCommentAddResult.Type;

export const ReviewCommentListResult = Schema.Struct({
  comments: Schema.Array(ReviewComment),
});
export type ReviewCommentListResult = typeof ReviewCommentListResult.Type;

export const ReviewCommentPublishResult = Schema.Struct({
  published: Schema.Number,
  failed: Schema.optional(Schema.Number),
  url: Schema.optional(Schema.String),
  /** Human-readable error when publishing fails (e.g. gh api error output). */
  error: Schema.optional(Schema.String),
});
export type ReviewCommentPublishResult = typeof ReviewCommentPublishResult.Type;
