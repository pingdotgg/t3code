import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PullRequestRef } from "./pullRequest.ts";

export const AzureDevOpsReviewVote = Schema.Literals([
  "approve",
  "approve-with-suggestions",
  "wait-for-author",
  "reject",
  "reset",
]);
export type AzureDevOpsReviewVote = typeof AzureDevOpsReviewVote.Type;
export const AzureDevOpsMergeStrategy = Schema.Literals([
  "noFastForward",
  "squash",
  "rebase",
  "rebaseMerge",
]);
const AttachmentName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(255),
  Schema.isPattern(/^[^/\\]+$/),
  Schema.isPattern(/^\P{Cc}+$/u),
);
const BranchName = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));
export const PullRequestHostAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("vote"), vote: AzureDevOpsReviewVote }),
  Schema.Struct({
    type: Schema.Literal("attachment-upload"),
    fileName: AttachmentName,
    data: Schema.String.check(
      Schema.isMaxLength(13_981_016),
      Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("attachment-delete"), fileName: AttachmentName }),
  Schema.Struct({
    type: Schema.Literal("share"),
    receivers: Schema.Array(TrimmedNonEmptyString).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(25),
    ),
    message: Schema.String.check(Schema.isMaxLength(4000)),
  }),
  Schema.Struct({
    type: Schema.Literal("apply-suggestion"),
    commentId: TrimmedNonEmptyString,
    expectedHead: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("follow"), enabled: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("favorite-source"), enabled: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("decline-review"), declined: Schema.Boolean }),
  Schema.Struct({
    type: Schema.Literal("reviewer-flag"),
    reviewerId: TrimmedNonEmptyString,
    flagged: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("retarget"), branch: BranchName }),
  Schema.Struct({
    type: Schema.Literal("reviewer-required"),
    reviewerId: TrimmedNonEmptyString,
    required: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("work-items"),
    ids: Schema.Array(PositiveInt).check(Schema.isMinLength(1), Schema.isMaxLength(25)),
    linked: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("complete"),
    automatic: Schema.Boolean,
    strategy: AzureDevOpsMergeStrategy,
    deleteSourceBranch: Schema.Boolean,
    transitionWorkItems: Schema.Boolean,
    message: Schema.String.check(Schema.isMaxLength(65536)),
    bypassPolicy: Schema.Boolean,
    bypassReason: Schema.String.check(Schema.isMaxLength(4096)),
    waitForOptionalPolicies: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("restart-merge") }),
  Schema.Struct({ type: Schema.Literal("requeue-policy"), evaluationId: TrimmedNonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("cherry-pick"),
    targetBranch: BranchName,
    newBranch: BranchName,
    createPullRequest: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("revert"),
    targetBranch: BranchName,
    newBranch: BranchName,
    createPullRequest: Schema.optional(Schema.Boolean),
  }),
]);
export type PullRequestHostAction = typeof PullRequestHostAction.Type;
export const PullRequestHostActionInput = Schema.Struct({
  ...PullRequestRef.fields,
  action: PullRequestHostAction,
});
export type PullRequestHostActionInput = typeof PullRequestHostActionInput.Type;
export const PullRequestHostActionResult = Schema.Struct({
  message: Schema.String,
  url: Schema.NullOr(Schema.String),
});
export type PullRequestHostActionResult = typeof PullRequestHostActionResult.Type;
export const PullRequestHostDetails = Schema.Struct({
  provider: Schema.Literal("azure-devops"),
  deniedActions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowedMergeStrategies: Schema.optional(Schema.Array(AzureDevOpsMergeStrategy)),
  viewerId: Schema.String,
  canDeclineReview: Schema.Boolean,
  canFlagReview: Schema.Boolean,
  following: Schema.NullOr(Schema.Boolean),
  sourceBranchFavorite: Schema.NullOr(Schema.Boolean),
  reviewers: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      login: Schema.String,
      name: Schema.String,
      required: Schema.Boolean,
      vote: Schema.Int,
      group: Schema.Boolean,
      flagged: Schema.Boolean,
      declined: Schema.Boolean,
    }),
  ),
  policies: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      configurationId: Schema.Int,
      name: Schema.String,
      status: Schema.String,
      required: Schema.Boolean,
      url: Schema.NullOr(Schema.String),
    }),
  ),
  workItems: Schema.Array(
    Schema.Struct({
      id: PositiveInt,
      title: Schema.String,
      state: Schema.String,
      url: Schema.String,
    }),
  ),
  attachments: Schema.Array(Schema.Struct({ name: Schema.String, url: Schema.String })),
  branches: Schema.Array(Schema.String),
  mergePreviewUrl: Schema.NullOr(Schema.String),
  warnings: Schema.Array(Schema.String),
});
export type PullRequestHostDetails = typeof PullRequestHostDetails.Type;
