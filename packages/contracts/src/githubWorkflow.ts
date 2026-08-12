import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const GitHubWorkflowInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  required: Schema.Boolean,
  type: Schema.optional(Schema.Literals(["boolean", "choice", "number", "environment", "string"])),
  defaultValue: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(Schema.String)),
});
export type GitHubWorkflowInput = typeof GitHubWorkflowInput.Type;

export const GitHubWorkflow = Schema.Struct({
  filename: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  inputs: Schema.Array(GitHubWorkflowInput),
});
export type GitHubWorkflow = typeof GitHubWorkflow.Type;

export const GitHubWorkflowListInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type GitHubWorkflowListInput = typeof GitHubWorkflowListInput.Type;

export const GitHubWorkflowListResult = Schema.Struct({
  workflows: Schema.Array(GitHubWorkflow),
});
export type GitHubWorkflowListResult = typeof GitHubWorkflowListResult.Type;

export const GitHubWorkflowRunInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  filename: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  ref: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  inputs: Schema.Record(
    TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    Schema.String.check(Schema.isMaxLength(10_000)),
  ),
});
export type GitHubWorkflowRunInput = typeof GitHubWorkflowRunInput.Type;

export const GitHubWorkflowRunResult = Schema.Struct({
  url: Schema.optional(TrimmedNonEmptyString),
});
export type GitHubWorkflowRunResult = typeof GitHubWorkflowRunResult.Type;
