import * as Data from "effect/Data";

import type { RepositoryBranchesError, RepositoryStatusError } from "./git.errors";
import type { SyncRepositoryError } from "./repo.errors";

export class InvalidWorktreeOptionsError extends Data.TaggedError("InvalidWorktreeOptionsError")<{
  readonly message: string;
}> {}

export class WorktreeCommandError extends Data.TaggedError("WorktreeCommandError")<{
  readonly message: string;
  readonly sandboxId: string;
  readonly cwd: string;
  readonly cause: unknown;
}> {}

export class WorktreeBootstrapError extends Data.TaggedError("WorktreeBootstrapError")<{
  readonly message: string;
  readonly sandboxId: string;
  readonly repoPath: string;
  readonly cause: unknown;
}> {}

export class WorktreeCleanupError extends Data.TaggedError("WorktreeCleanupError")<{
  readonly message: string;
  readonly sandboxId: string;
  readonly repoPath: string;
  readonly cause: unknown;
}> {}

export type CreateWorktreeError =
  | InvalidWorktreeOptionsError
  | SyncRepositoryError
  | RepositoryBranchesError
  | RepositoryStatusError
  | WorktreeCommandError
  | WorktreeBootstrapError;

export type RemoveWorktreeError =
  | InvalidWorktreeOptionsError
  | WorktreeCommandError
  | WorktreeCleanupError;
