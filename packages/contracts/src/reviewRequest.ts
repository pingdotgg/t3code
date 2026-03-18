import { Schema } from "effect";
import { PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

export const ReviewRequestStatus = Schema.Literals(["pending", "in_review", "dismissed"]);
export type ReviewRequestStatus = typeof ReviewRequestStatus.Type;

export const ReviewRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  prUrl: Schema.String,
  prNumber: PositiveInt,
  prTitle: TrimmedNonEmptyString,
  repoNameWithOwner: TrimmedNonEmptyString,
  authorLogin: TrimmedNonEmptyString,
  isBot: Schema.Boolean,
  status: ReviewRequestStatus,
  threadId: Schema.optional(ThreadId),
  prBody: Schema.optional(Schema.String),
  prLabels: Schema.optional(Schema.Array(Schema.String)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ReviewRequest = typeof ReviewRequest.Type;

// ── WS Inputs ────────────────────────────────────────────────────────

export const ReviewRequestListInput = Schema.Struct({});
export type ReviewRequestListInput = typeof ReviewRequestListInput.Type;

export const ReviewRequestListResult = Schema.Struct({
  reviewRequests: Schema.Array(ReviewRequest),
});
export type ReviewRequestListResult = typeof ReviewRequestListResult.Type;

export const ReviewRequestDismissInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type ReviewRequestDismissInput = typeof ReviewRequestDismissInput.Type;

export const ReviewRequestLinkThreadInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
});
export type ReviewRequestLinkThreadInput = typeof ReviewRequestLinkThreadInput.Type;

export const ReviewRequestSubmitEvent = Schema.Literals(["APPROVE", "REQUEST_CHANGES"]);
export type ReviewRequestSubmitEvent = typeof ReviewRequestSubmitEvent.Type;

export const ReviewRequestSubmitInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  prUrl: Schema.String,
  event: ReviewRequestSubmitEvent,
  body: Schema.optional(Schema.String),
});
export type ReviewRequestSubmitInput = typeof ReviewRequestSubmitInput.Type;
