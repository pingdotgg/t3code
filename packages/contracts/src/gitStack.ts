import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const GitStackStatusInput = Schema.Struct({ cwd: TrimmedNonEmptyString });
export type GitStackStatusInput = typeof GitStackStatusInput.Type;
export const GitStackManageInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  action: Schema.Literals(["adopt", "edit", "update", "continue", "abort", "untrack"]),
  includeLatestBase: Schema.optional(Schema.Boolean),
  expectedBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  branches: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  ),
  base: Schema.optional(TrimmedNonEmptyString),
});
export type GitStackManageInput = typeof GitStackManageInput.Type;
export const GitStackStatusResult = Schema.Struct({
  managed: Schema.Boolean,
  baseIsDefault: Schema.Boolean,
  base: Schema.String,
  remote: Schema.String,
  layers: Schema.Array(
    Schema.Struct({
      branch: Schema.String,
      parent: Schema.String,
      headSha: Schema.String,
      needsRestack: Schema.Boolean,
      hasChanges: Schema.Boolean,
      current: Schema.Boolean,
      worktreePath: Schema.NullOr(Schema.String),
      pullRequest: Schema.NullOr(
        Schema.Struct({
          number: Schema.Number,
          url: Schema.String,
          state: Schema.Literals(["open", "closed", "merged"]),
        }),
      ),
    }),
  ),
  operation: Schema.NullOr(
    Schema.Struct({
      branch: Schema.String,
      cwd: Schema.String,
      publishThrough: Schema.optional(Schema.String),
      phase: Schema.Literals(["rebase", "push", "hooks"]),
    }),
  ),
});
export type GitStackStatusResult = typeof GitStackStatusResult.Type;
