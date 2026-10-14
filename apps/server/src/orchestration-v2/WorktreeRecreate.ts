import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";

export class WorktreeRecreateError extends Schema.TaggedError<WorktreeRecreateError>()(
  "WorktreeRecreateError",
  {
    worktreePath: Schema.String,
    branch: Schema.String,
    reason: Schema.Literals(["no-base-ref", "create-failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "no-base-ref") {
      return `Could not recreate branch '${this.branch}' at ${this.worktreePath}: the project workspace has no current branch to start it from (detached HEAD?).`;
    }
    return `Could not recreate the worktree for branch '${this.branch}' at ${this.worktreePath}.`;
  }
}

const toRecreateError =
  (input: { readonly worktreePath: string; readonly branch: string }) =>
  (cause: unknown): WorktreeRecreateError =>
    new WorktreeRecreateError({
      worktreePath: input.worktreePath,
      branch: input.branch,
      reason: "create-failed",
      cause,
    });

/**
 * Recreates a thread's worktree folder after it was deleted outside T3, on the
 * thread's branch, or on a fresh branch of the same name from the project's
 * current branch when that branch was deleted too.
 */
export const recreateMissingWorktree = (input: {
  readonly gitWorkflow: GitWorkflowService.GitWorkflowService["Service"];
  readonly cwd: string;
  readonly worktreePath: string;
  readonly branch: string;
}): Effect.Effect<void, WorktreeRecreateError> =>
  Effect.gen(function* () {
    const { gitWorkflow, cwd, worktreePath, branch } = input;
    const onFailure = toRecreateError({ worktreePath, branch });
    yield* gitWorkflow.pruneWorktrees({ cwd }).pipe(Effect.mapError(onFailure));
    const localBranchNames = yield* gitWorkflow
      .listLocalBranchNames(cwd)
      .pipe(Effect.mapError(onFailure));
    if (localBranchNames.includes(branch)) {
      yield* gitWorkflow
        .createWorktree({ cwd, refName: branch, path: worktreePath })
        .pipe(Effect.mapError(onFailure));
      return;
    }
    const localStatus = yield* gitWorkflow.localStatus({ cwd }).pipe(Effect.mapError(onFailure));
    const baseRef = localStatus.refName;
    if (baseRef === null) {
      return yield* new WorktreeRecreateError({ worktreePath, branch, reason: "no-base-ref" });
    }
    yield* gitWorkflow
      .createWorktree({
        cwd,
        refName: baseRef,
        newRefName: branch,
        baseRefName: baseRef,
        path: worktreePath,
      })
      .pipe(Effect.mapError(onFailure));
  });
