import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  PullRequestActor,
  PullRequestChecksState,
  PullRequestMergeability,
  PullRequestReviewDecision,
  PullRequestState,
} from "./pullRequest.ts";

/**
 * Legacy single-PR link. Still emitted as the thread's derived current pull
 * request (see `@t3tools/shared/threadPullRequests`) so clients from before
 * `pullRequests` keep working independently of their release schedule.
 */
export const ThreadLinkedPullRequest = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
});
export type ThreadLinkedPullRequest = typeof ThreadLinkedPullRequest.Type;

/** Who created a thread ↔ pull request link. `stack-dismissed` is a tombstone
 * for a native-stack member the user unlinked, so the sync reactor does not
 * re-add it; clients hide it. */
export const ThreadPullRequestLinkSource = Schema.Literals([
  "manual",
  "created",
  "agent",
  "stack",
  "stack-dismissed",
]);
export type ThreadPullRequestLinkSource = typeof ThreadPullRequestLinkSource.Type;

/**
 * Host state persisted on a link by the sync reactor; null until first sync. The overview
 * fields are optional: a host whose cheap read lacks them leaves them out, and snapshots
 * written before they existed still decode.
 */
export const ThreadPullRequestSnapshot = Schema.Struct({
  state: PullRequestState,
  title: TrimmedNonEmptyString,
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  isDraft: Schema.Boolean,
  updatedAt: Schema.NullOr(IsoDateTime),
  syncedAt: IsoDateTime,
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(PullRequestActor)),
  additions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
  changedFiles: Schema.optional(NonNegativeInt),
  reviewDecision: Schema.optional(Schema.NullOr(PullRequestReviewDecision)),
  checksState: Schema.optional(Schema.NullOr(PullRequestChecksState)),
  mergeability: Schema.optional(PullRequestMergeability),
});
export type ThreadPullRequestSnapshot = typeof ThreadPullRequestSnapshot.Type;

export const ThreadPullRequestStackLayer = Schema.Struct({
  number: PositiveInt,
  headBranch: TrimmedNonEmptyString,
  state: PullRequestState,
});
export type ThreadPullRequestStackLayer = typeof ThreadPullRequestStackLayer.Type;

/** A host-native stack the pull request belongs to. Layers run bottom to top. */
export const ThreadPullRequestStack = Schema.Struct({
  kind: Schema.Literal("native"),
  id: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  base: TrimmedNonEmptyString,
  layers: Schema.Array(ThreadPullRequestStackLayer),
});
export type ThreadPullRequestStack = typeof ThreadPullRequestStack.Type;

/** Identity of a pull request as a thread link sees it: host-level, so the
 * same PR linked from two projects (or two environments) compares equal. */
export const ThreadPullRequestKey = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type ThreadPullRequestKey = typeof ThreadPullRequestKey.Type;

/**
 * Present while the server watches the pull request for its thread. The server wakes the
 * thread's agent when checks finish on the head commit, someone else comments, or the branch
 * starts to conflict. The other fields record what the agent was last told, so each change is
 * reported once.
 */
export const ThreadPullRequestWatch = Schema.Struct({
  startedAt: IsoDateTime,
  /** Head commit whose check result was last reported; null until one is. */
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  /** Last reported result: `failing` while other checks still run, `failed` once all finished. */
  checks: Schema.NullOr(Schema.Literals(["passing", "failing", "failed"])),
  /** Remarks from others created up to this host time were reported. */
  remarksThrough: IsoDateTime,
  /** Remarks created exactly at `remarksThrough` that were reported, so a late one still counts. */
  remarkIds: Schema.Array(TrimmedNonEmptyString),
  conflicting: Schema.Boolean,
  /** Comment-only wakes in a row. Watching stops at a limit, so bots cannot loop it. */
  wakes: NonNegativeInt,
});
export type ThreadPullRequestWatch = typeof ThreadPullRequestWatch.Type;

export const ThreadPullRequestLink = Schema.Struct({
  ...ThreadPullRequestKey.fields,
  url: TrimmedNonEmptyString,
  source: ThreadPullRequestLinkSource,
  linkedAt: IsoDateTime,
  snapshot: Schema.NullOr(ThreadPullRequestSnapshot),
  stack: Schema.NullOr(ThreadPullRequestStack),
  watch: Schema.optional(ThreadPullRequestWatch),
});
export type ThreadPullRequestLink = typeof ThreadPullRequestLink.Type;
