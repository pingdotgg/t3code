import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PullRequestActor, PullRequestLabel, PullRequestReaction } from "./pullRequest.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

export const IssueState = Schema.Literals(["open", "closed"]);
export type IssueState = typeof IssueState.Type;

export const IssueStateReason = Schema.Literals(["completed", "not-planned", "duplicate"]);
export type IssueStateReason = typeof IssueStateReason.Type;

export const IssueComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  editedAt: Schema.NullOr(IsoDateTime),
  url: Schema.NullOr(Schema.String),
  reactions: Schema.Array(PullRequestReaction),
});
export type IssueComment = typeof IssueComment.Type;

/** Read with `PullRequestRef`: a repository numbers its issues and pull requests from one sequence. */
export const IssueDetail = Schema.Struct({
  provider: SourceControlProviderKind,
  projectId: ProjectId,
  workspaceRoot: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  state: IssueState,
  /** Why a closed issue closed, where the host says. */
  stateReason: Schema.NullOr(IssueStateReason),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
  labels: Schema.Array(PullRequestLabel),
  assignees: Schema.Array(PullRequestActor),
  reactions: Schema.Array(PullRequestReaction),
  /** The most recent comments, oldest first. */
  comments: Schema.Array(IssueComment),
  commentCount: NonNegativeInt,
  /** `comments` holds fewer than `commentCount`; the rest are only on the host. */
  commentsTruncated: Schema.Boolean,
});
export type IssueDetail = typeof IssueDetail.Type;

/**
 * GitHub serves pull requests under `/issues/{n}` too, so a link that looks like an issue may
 * name one. The read says which it found rather than failing on the pull request.
 */
export const IssueReadResult = Schema.Union([
  Schema.TaggedStruct("issue", { issue: IssueDetail }),
  Schema.TaggedStruct("pull-request", { url: TrimmedNonEmptyString }),
]);
export type IssueReadResult = typeof IssueReadResult.Type;
