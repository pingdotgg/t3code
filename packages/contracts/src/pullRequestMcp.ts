import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  PullRequestCheckFailure,
  PullRequestCheckStatus,
  PullRequestCommentKind,
  PullRequestMergeability,
  PullRequestReviewDecision,
  PullRequestState,
} from "./pullRequest.ts";

/** A pull request named the way link_pull_request names one. */
export const PullRequestReadTarget = Schema.Struct({
  url: Schema.optional(TrimmedNonEmptyString),
  repository: Schema.optional(
    TrimmedNonEmptyString.annotate({ description: "With `number`, when no `url`." }),
  ),
  number: Schema.optional(
    PositiveInt.annotate({ description: "With `repository`, when no `url`." }),
  ),
  host: Schema.optional(
    TrimmedNonEmptyString.annotate({ description: "Default: this project's host." }),
  ),
});
export type PullRequestReadTarget = typeof PullRequestReadTarget.Type;

const DEFAULT_TARGET = "Default: links on this thread or its parent, else the open branch PR.";

export const PullRequestStatusInput = Schema.Struct({
  pullRequests: Schema.optional(
    Schema.Array(PullRequestReadTarget)
      .check(Schema.isMinLength(1), Schema.isMaxLength(20))
      .annotate({ description: DEFAULT_TARGET }),
  ),
});
export type PullRequestStatusInput = typeof PullRequestStatusInput.Type;

/** One pull request: the thread's single default, or the one named. */
export const PullRequestReadInput = Schema.Struct({
  pullRequests: Schema.optional(
    Schema.Array(PullRequestReadTarget)
      .check(Schema.isMinLength(1), Schema.isMaxLength(1))
      .annotate({
        description:
          "One PR per call: URL or repository + number. Omit for the sole PR on this thread, its parent or this branch.",
      }),
  ),
});
export type PullRequestReadInput = typeof PullRequestReadInput.Type;

export const PullRequestFailuresInput = Schema.Struct({
  ...PullRequestReadInput.fields,
  checks: Schema.optional(
    Schema.Array(TrimmedNonEmptyString)
      .check(Schema.isMinLength(1), Schema.isMaxLength(5))
      .annotate({ description: "Check names. Default: the failing checks." }),
  ),
});
export type PullRequestFailuresInput = typeof PullRequestFailuresInput.Type;

export const PullRequestResolvedVia = Schema.Literals([
  "linked",
  "parent-linked",
  "branch",
  "named",
]);
export type PullRequestResolvedVia = typeof PullRequestResolvedVia.Type;

/** Absent on the host's check means unknown; it never becomes a boolean. */
export const PullRequestCheckRequired = Schema.Literals(["yes", "no", "unknown"]);
export type PullRequestCheckRequired = typeof PullRequestCheckRequired.Type;

export const PullRequestChecksVerdict = Schema.Literals([
  "passing",
  "stale-head",
  "failing",
  "pending",
  "none",
  "unknown",
]);
export type PullRequestChecksVerdict = typeof PullRequestChecksVerdict.Type;

const NamedCheck = Schema.Struct({
  name: TrimmedNonEmptyString,
  required: PullRequestCheckRequired,
});

export const PullRequestChecksStatus = Schema.Struct({
  verdict: PullRequestChecksVerdict,
  /** The commit these checks describe. */
  headSha: Schema.optional(TrimmedNonEmptyString),
  passed: NonNegativeInt,
  failed: NonNegativeInt,
  pending: NonNegativeInt,
  skipped: NonNegativeInt,
  failing: Schema.Array(
    Schema.Struct({
      ...NamedCheck.fields,
      status: PullRequestCheckStatus,
      handle: Schema.optional(TrimmedNonEmptyString),
      summary: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
      url: Schema.NullOr(Schema.String),
    }),
  ).check(Schema.isMaxLength(20)),
  waiting: Schema.Array(NamedCheck).check(Schema.isMaxLength(20)),
});
export type PullRequestChecksStatus = typeof PullRequestChecksStatus.Type;

export const PullRequestStatusEntry = Schema.TaggedStruct("Status", {
  url: TrimmedNonEmptyString,
  number: PositiveInt,
  title: Schema.String,
  state: PullRequestState,
  isDraft: Schema.Boolean,
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  headSha: Schema.optional(TrimmedNonEmptyString),
  mergeability: PullRequestMergeability,
  reviewDecision: Schema.NullOr(PullRequestReviewDecision),
  checks: PullRequestChecksStatus,
  observedAt: Schema.Struct({
    summary: Schema.optional(IsoDateTime),
    checks: Schema.optional(IsoDateTime),
  }),
  /** `PR <url>, head <sha>, checks <verdict> (<detail>), reviews <decision>, <mergeability>`. */
  report: Schema.String,
  resolvedVia: PullRequestResolvedVia,
});
export type PullRequestStatusEntry = typeof PullRequestStatusEntry.Type;

export const PullRequestRateLimited = Schema.TaggedStruct("RateLimited", {
  until: IsoDateTime,
  message: Schema.String,
});
export type PullRequestRateLimited = typeof PullRequestRateLimited.Type;

export const PullRequestReadUnavailable = Schema.TaggedStruct("Unavailable", {
  url: Schema.optional(TrimmedNonEmptyString),
  number: Schema.optional(PositiveInt),
  message: Schema.String,
});
export type PullRequestReadUnavailable = typeof PullRequestReadUnavailable.Type;

export const PullRequestStatusReport = Schema.Struct({
  pullRequests: Schema.Array(
    Schema.Union([PullRequestStatusEntry, PullRequestReadUnavailable, PullRequestRateLimited]),
  ),
});
export type PullRequestStatusReport = typeof PullRequestStatusReport.Type;

export const PullRequestFailureReport = Schema.TaggedStruct("Failures", {
  url: TrimmedNonEmptyString,
  number: PositiveInt,
  headSha: Schema.optional(TrimmedNonEmptyString),
  observedAt: Schema.optional(IsoDateTime),
  failures: Schema.Array(PullRequestCheckFailure).check(Schema.isMaxLength(5)),
  omitted: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      status: PullRequestCheckStatus,
      url: Schema.NullOr(Schema.String),
      reason: Schema.Literals(["no-handle", "over-limit", "read-failed"]),
    }),
  ),
});
export type PullRequestFailureReport = typeof PullRequestFailureReport.Type;

const FeedbackBody = Schema.String.check(Schema.isMaxLength(2000));

export const PullRequestFeedbackComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: PullRequestCommentKind,
  author: Schema.NullOr(TrimmedNonEmptyString),
  isBot: Schema.Boolean,
  body: FeedbackBody,
  createdAt: IsoDateTime,
  url: Schema.NullOr(Schema.String),
  reviewState: Schema.NullOr(Schema.String),
});
export type PullRequestFeedbackComment = typeof PullRequestFeedbackComment.Type;

export const PullRequestFeedbackThread = Schema.Struct({
  id: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  line: Schema.NullOr(PositiveInt),
  url: Schema.NullOr(Schema.String),
  comments: Schema.Array(
    Schema.Struct({
      author: Schema.NullOr(TrimmedNonEmptyString),
      isBot: Schema.Boolean,
      body: FeedbackBody,
      createdAt: IsoDateTime,
    }),
  ).check(Schema.isMaxLength(10)),
});
export type PullRequestFeedbackThread = typeof PullRequestFeedbackThread.Type;

export const PullRequestFeedbackReport = Schema.TaggedStruct("Feedback", {
  url: TrimmedNonEmptyString,
  number: PositiveInt,
  reviewDecision: Schema.NullOr(PullRequestReviewDecision),
  /** Unresolved, current review threads, newest first. */
  threads: Schema.Array(PullRequestFeedbackThread).check(Schema.isMaxLength(30)),
  /** Reviews and conversation comments, newest first. */
  comments: Schema.Array(PullRequestFeedbackComment).check(Schema.isMaxLength(30)),
  truncated: Schema.Boolean,
});
export type PullRequestFeedbackReport = typeof PullRequestFeedbackReport.Type;
