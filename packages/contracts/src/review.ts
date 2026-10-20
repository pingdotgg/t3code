import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitCommandError, GitManagerServiceError } from "./git.ts";
import { VcsError } from "./vcs.ts";

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  workingTreeScope: Schema.optionalKey(Schema.Literals(["staged", "unstaged"])),
  file: Schema.optionalKey(
    Schema.Struct({
      path: Schema.NonEmptyString,
      previousPath: Schema.NullOr(Schema.NonEmptyString),
      sourceKind: Schema.Literals(["working-tree", "branch-range"]),
    }),
  ),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewSetStagedInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  paths: Schema.Array(TrimmedNonEmptyString),
  staged: Schema.Boolean,
  patch: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(2_000_000))),
});
export type ReviewSetStagedInput = typeof ReviewSetStagedInput.Type;

export const ReviewGenerateCommitMessageInput = Schema.Struct({ cwd: TrimmedNonEmptyString });
export type ReviewGenerateCommitMessageInput = typeof ReviewGenerateCommitMessageInput.Type;

export const ReviewCommitInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  message: Schema.String.check(Schema.isMaxLength(10_000)),
  action: Schema.Literals(["commit", "amend", "commit-push"]),
});
export type ReviewCommitInput = typeof ReviewCommitInput.Type;
export const ReviewCommitResult = Schema.Struct({
  commitSha: Schema.NonEmptyString,
  pushStatus: Schema.Literals(["not-requested", "pushed", "failed"]),
});
export type ReviewCommitResult = typeof ReviewCommitResult.Type;
export const ReviewRevertInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  paths: Schema.Array(TrimmedNonEmptyString),
  patch: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(2_000_000))),
});
export type ReviewRevertInput = typeof ReviewRevertInput.Type;

export const ReviewDiffPreviewSourceKind = Schema.Literals(["working-tree", "branch-range"]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

export const ReviewDiffFileStat = Schema.Struct({
  path: Schema.String,
  previousPath: Schema.NullOr(Schema.String),
  additions: Schema.Number,
  deletions: Schema.Number,
  /** Available before its patch is loaded. Absent on older servers. */
  status: Schema.optionalKey(Schema.Literals(["added", "deleted", "modified", "renamed"])),
});
export type ReviewDiffFileStat = typeof ReviewDiffFileStat.Type;

export const ReviewDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewDiffPreviewSourceKind,
  title: TrimmedNonEmptyString,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
  files: Schema.optionalKey(Schema.Array(ReviewDiffFileStat)),
});
export type ReviewDiffPreviewSource = typeof ReviewDiffPreviewSource.Type;

export const ReviewDiffFileContentsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  workingTreeScope: Schema.optionalKey(Schema.Literals(["staged", "unstaged"])),
  sourceKind: ReviewDiffPreviewSourceKind,
  changeType: Schema.Literals(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  oldPath: TrimmedNonEmptyString,
  newPath: TrimmedNonEmptyString,
});
export type ReviewDiffFileContentsInput = typeof ReviewDiffFileContentsInput.Type;

export const ReviewDiffFileContentsResult = Schema.Struct({
  oldContents: Schema.String,
  newContents: Schema.String,
});
export type ReviewDiffFileContentsResult = typeof ReviewDiffFileContentsResult.Type;

export const ReviewDiffPreviewResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(ReviewDiffPreviewSource),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;

export const ReviewCommitError = Schema.Union([ReviewDiffPreviewError, GitManagerServiceError]);
export type ReviewCommitError = typeof ReviewCommitError.Type;
