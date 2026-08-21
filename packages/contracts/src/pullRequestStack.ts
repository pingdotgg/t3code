import * as Schema from "effect/Schema";

import { PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PullRequestMergeMethod } from "./pullRequest.ts";

export const PullRequestStackAvailability = Schema.Literals(["available", "unsupported"]);
export type PullRequestStackAvailability = typeof PullRequestStackAvailability.Type;

export const PullRequestStackStepState = Schema.Literals(["open", "closed", "merged", "queued"]);
export type PullRequestStackStepState = typeof PullRequestStackStepState.Type;

export const PullRequestStackStep = Schema.Struct({
  position: PositiveInt,
  pullRequestNumber: PositiveInt,
  branch: TrimmedNonEmptyString,
  state: PullRequestStackStepState,
  draft: Schema.Boolean,
});
export type PullRequestStackStep = typeof PullRequestStackStep.Type;

export const PullRequestStackSummary = Schema.Struct({
  id: PositiveInt,
  number: PositiveInt,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyString,
  open: Schema.Boolean,
  steps: Schema.Array(PullRequestStackStep),
});
export type PullRequestStackSummary = typeof PullRequestStackSummary.Type;

export const PullRequestLocalStackPullRequest = Schema.Struct({
  number: PositiveInt,
  url: Schema.optional(Schema.String),
  state: PullRequestStackStepState,
});
export type PullRequestLocalStackPullRequest = typeof PullRequestLocalStackPullRequest.Type;

export const PullRequestLocalStackStep = Schema.Struct({
  position: PositiveInt,
  branch: TrimmedNonEmptyString,
  head: Schema.optional(TrimmedNonEmptyString),
  base: Schema.optional(TrimmedNonEmptyString),
  isCurrent: Schema.Boolean,
  isMerged: Schema.Boolean,
  isQueued: Schema.Boolean,
  needsRebase: Schema.Boolean,
  pullRequest: Schema.NullOr(PullRequestLocalStackPullRequest),
});
export type PullRequestLocalStackStep = typeof PullRequestLocalStackStep.Type;

export const PullRequestLocalStack = Schema.Struct({
  trunk: TrimmedNonEmptyString,
  currentBranch: TrimmedNonEmptyString,
  steps: Schema.Array(PullRequestLocalStackStep),
});
export type PullRequestLocalStack = typeof PullRequestLocalStack.Type;

export const PullRequestStackListInput = Schema.Struct({
  projectId: ProjectId,
});
export type PullRequestStackListInput = typeof PullRequestStackListInput.Type;

export const PullRequestStackListResult = Schema.Struct({
  availability: PullRequestStackAvailability,
  stacks: Schema.Array(PullRequestStackSummary),
});
export type PullRequestStackListResult = typeof PullRequestStackListResult.Type;

export const PullRequestStackCurrentInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type PullRequestStackCurrentInput = typeof PullRequestStackCurrentInput.Type;

export const PullRequestStackCurrentResult = Schema.Struct({
  availability: Schema.Literals(["available", "extension_missing", "unsupported"]),
  stack: Schema.NullOr(PullRequestLocalStack),
});
export type PullRequestStackCurrentResult = typeof PullRequestStackCurrentResult.Type;

export const PullRequestStackAction = Schema.Literals([
  "start",
  "add_step",
  "submit",
  "sync",
  "unstack",
]);
export type PullRequestStackAction = typeof PullRequestStackAction.Type;

export const PullRequestStackActionInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  action: PullRequestStackAction,
  branch: Schema.optional(TrimmedNonEmptyString),
  baseBranch: Schema.optional(TrimmedNonEmptyString),
});
export type PullRequestStackActionInput = typeof PullRequestStackActionInput.Type;

export const PullRequestStackActionResult = Schema.Struct({
  action: PullRequestStackAction,
  stack: Schema.NullOr(PullRequestLocalStack),
});
export type PullRequestStackActionResult = typeof PullRequestStackActionResult.Type;

export const PullRequestStackMergeInput = Schema.Struct({
  projectId: ProjectId,
  pullRequestNumber: PositiveInt,
  mergeMethod: PullRequestMergeMethod,
});
export type PullRequestStackMergeInput = typeof PullRequestStackMergeInput.Type;

export const PullRequestStackMergeResult = Schema.Struct({
  status: Schema.Literals(["merged", "queued"]),
});
export type PullRequestStackMergeResult = typeof PullRequestStackMergeResult.Type;

export class PullRequestStackError extends Schema.TaggedErrorClass<PullRequestStackError>()(
  "PullRequestStackError",
  {
    operation: TrimmedNonEmptyString,
    projectId: Schema.optional(ProjectId),
    cwd: Schema.optional(TrimmedNonEmptyString),
    detail: TrimmedNonEmptyString,
    exitCode: Schema.optional(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Pull request stack operation ${this.operation} failed: ${this.detail}`;
  }
}
