import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const GitWorkflowProgressInput = Schema.Struct({ cwd: TrimmedNonEmptyString });
export const GitWorkflowStep = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  group: Schema.String,
  state: Schema.Literals(["pending", "running", "completed", "failed", "skipped"]),
});
export type GitWorkflowStep = typeof GitWorkflowStep.Type;
export const GitWorkflowProgressUpdate = Schema.Struct({
  label: Schema.String,
  steps: Schema.Array(GitWorkflowStep),
});
export type GitWorkflowProgressUpdate = typeof GitWorkflowProgressUpdate.Type;
export const GitWorkflowProgress = Schema.Struct({
  ...GitWorkflowProgressUpdate.fields,
  kind: Schema.Literals(["stack", "logical_commits"]),
  state: Schema.Literals(["running", "completed", "failed", "cancelled"]),
  startedAtMs: Schema.Number,
});
export type GitWorkflowProgress = typeof GitWorkflowProgress.Type;
