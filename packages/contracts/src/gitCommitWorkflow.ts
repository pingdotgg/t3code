import * as Schema from "effect/Schema";
import { CommandId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const GitCommitWorkflowScope = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["working_tree", "working_tree_new_branch"]),
    filePaths: Schema.optional(
      Schema.Array(Schema.String.check(Schema.isNonEmpty())).check(Schema.isMinLength(1)),
    ),
  }),
  Schema.Struct({
    type: Schema.Literals(["branch", "branch_range"]),
    baseRef: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
    startCommit: Schema.optional(
      TrimmedNonEmptyString.check(Schema.isPattern(/^[0-9a-f]{40,64}$/)),
    ),
    endCommit: Schema.optional(TrimmedNonEmptyString.check(Schema.isPattern(/^[0-9a-f]{40,64}$/))),
    expectedHeadSha: Schema.optional(
      TrimmedNonEmptyString.check(Schema.isPattern(/^[0-9a-f]{40,64}$/)),
    ),
  }),
]);
export type GitCommitWorkflowScope = typeof GitCommitWorkflowScope.Type;

export const GitStartCommitWorkflowInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  cwd: TrimmedNonEmptyString,
  expectedBranch: Schema.NullOr(TrimmedNonEmptyString),
  scope: GitCommitWorkflowScope,
  instructions: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(10_000))),
});
export type GitStartCommitWorkflowInput = typeof GitStartCommitWorkflowInput.Type;

export const GitStartCommitWorkflowResult = Schema.Struct({
  summary: Schema.String,
});
export type GitStartCommitWorkflowResult = typeof GitStartCommitWorkflowResult.Type;

export const GitCancelCommitWorkflowInput = Schema.Struct({
  commandId: CommandId,
  cwd: TrimmedNonEmptyString,
});
export type GitCancelCommitWorkflowInput = typeof GitCancelCommitWorkflowInput.Type;
