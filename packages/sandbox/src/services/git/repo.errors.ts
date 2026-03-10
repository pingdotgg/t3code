import * as Data from "effect/Data";

export class InvalidRepositorySetupError extends Data.TaggedError("InvalidRepositorySetupError")<{
  readonly message: string;
}> {}

export class GitHubRepositoryParseError extends Data.TaggedError("GitHubRepositoryParseError")<{
  readonly message: string;
}> {}

export class RepositoryCommandError extends Data.TaggedError("RepositoryCommandError")<{
  readonly message: string;
  readonly sandboxId: string;
  readonly cwd: string;
  readonly cause: unknown;
}> {}

export class RepositoryIdentityMismatchError extends Data.TaggedError(
  "RepositoryIdentityMismatchError",
)<{
  readonly message: string;
  readonly sandboxId: string;
  readonly repoPath: string;
}> {}

export class RepositoryStateError extends Data.TaggedError("RepositoryStateError")<{
  readonly message: string;
  readonly sandboxId: string;
  readonly repoPath: string;
  readonly cause: unknown;
}> {}

export class RepositorySyncError extends Data.TaggedError("RepositorySyncError")<{
  readonly message: string;
  readonly sandboxId: string;
  readonly repoPath: string;
  readonly cause: unknown;
}> {}

export class RepositoryCleanupError extends Data.TaggedError("RepositoryCleanupError")<{
  readonly message: string;
  readonly sandboxId: string;
  readonly repoPath: string;
  readonly cause: unknown;
}> {}

export type PrepareRepositoryError =
  | InvalidRepositorySetupError
  | GitHubRepositoryParseError
  | RepositoryCommandError
  | RepositoryIdentityMismatchError
  | RepositoryStateError;

export type SyncRepositoryError = RepositoryCommandError | RepositorySyncError;

export type GitHubRepositoryCleanupError = RepositoryCleanupError;
