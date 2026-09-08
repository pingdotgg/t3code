import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const GitButlerWorkspaceInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type GitButlerWorkspaceInput = typeof GitButlerWorkspaceInput.Type;

export const GitButlerFileChange = Schema.Struct({
  filePath: TrimmedNonEmptyString,
  changeType: TrimmedNonEmptyString,
});
export type GitButlerFileChange = typeof GitButlerFileChange.Type;

export const GitButlerCommit = Schema.Struct({
  commitId: TrimmedNonEmptyString,
  createdAt: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  authorName: TrimmedNonEmptyString,
  conflicted: Schema.Boolean,
  reviewId: Schema.NullOr(TrimmedNonEmptyString),
  changes: Schema.Array(GitButlerFileChange),
});
export type GitButlerCommit = typeof GitButlerCommit.Type;

export const GitButlerReviewStatus = Schema.Literals(["passing", "failing", "pending", "unknown"]);
export type GitButlerReviewStatus = typeof GitButlerReviewStatus.Type;

export const GitButlerBranch = Schema.Struct({
  name: TrimmedNonEmptyString,
  branchStatus: TrimmedNonEmptyString,
  reviewId: Schema.NullOr(TrimmedNonEmptyString),
  reviewNumber: Schema.NullOr(PositiveInt),
  reviewStatus: Schema.NullOr(GitButlerReviewStatus),
  commits: Schema.Array(GitButlerCommit),
  upstreamCommits: Schema.Array(GitButlerCommit),
});
export type GitButlerBranch = typeof GitButlerBranch.Type;

export const GitButlerStack = Schema.Struct({
  id: TrimmedNonEmptyString,
  assignedChanges: Schema.Array(GitButlerFileChange),
  branches: Schema.Array(GitButlerBranch),
});
export type GitButlerStack = typeof GitButlerStack.Type;

export const GitButlerWorkspaceStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ready"),
    version: TrimmedNonEmptyString,
    unassignedChanges: Schema.Array(GitButlerFileChange),
    conflictedFiles: Schema.Array(TrimmedNonEmptyString),
    stacks: Schema.Array(GitButlerStack),
    mergeBaseCommitId: TrimmedNonEmptyString,
    upstreamBehind: NonNegativeInt,
    upstreamLastFetched: Schema.NullOr(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    status: Schema.Literal("missing"),
    minimumVersion: TrimmedNonEmptyString,
    installHint: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("incompatible"),
    version: Schema.NullOr(TrimmedNonEmptyString),
    minimumVersion: TrimmedNonEmptyString,
    detail: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("notConfigured"),
    detail: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("error"),
    detail: TrimmedNonEmptyString,
  }),
]);
export type GitButlerWorkspaceStatus = typeof GitButlerWorkspaceStatus.Type;
