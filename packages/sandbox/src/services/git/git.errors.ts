import * as Data from "effect/Data";

export class InvalidGitCloneOptionsError extends Data.TaggedError("InvalidGitCloneOptionsError")<{
  readonly message: string;
}> {}

export class GitSandboxCreationError extends Data.TaggedError("GitSandboxCreationError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class GitCloneError extends Data.TaggedError("GitCloneError")<{
  readonly message: string;
  readonly sandboxId: string;
  readonly cause: unknown;
}> {}

export class RepositoryStatusError extends Data.TaggedError("RepositoryStatusError")<{
  readonly message: string;
  readonly sandboxId: string;
  readonly repoPath: string;
  readonly cause: unknown;
}> {}

export class RepositoryBranchesError extends Data.TaggedError("RepositoryBranchesError")<{
  readonly message: string;
  readonly sandboxId: string;
  readonly repoPath: string;
  readonly cause: unknown;
}> {}

export class RepositoryDiscoveryError extends Data.TaggedError("RepositoryDiscoveryError")<{
  readonly message: string;
  readonly sandboxId: string;
  readonly cause: unknown;
}> {}

export class RepositoryWorktreesError extends Data.TaggedError("RepositoryWorktreesError")<{
  readonly message: string;
  readonly sandboxId: string;
  readonly repoPath: string;
  readonly cause: unknown;
}> {}

export class GitCleanupError extends Data.TaggedError("GitCleanupError")<{
  readonly message: string;
}> {}

export class GitStartupCleanupError extends Data.TaggedError("GitStartupCleanupError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export type CloneRepositoryError =
  | InvalidGitCloneOptionsError
  | GitSandboxCreationError
  | GitCloneError
  | RepositoryStatusError
  | GitStartupCleanupError;
