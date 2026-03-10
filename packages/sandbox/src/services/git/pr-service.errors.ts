import * as Data from "effect/Data";

export class InvalidPullRequestOptionsError extends Data.TaggedError(
  "InvalidPullRequestOptionsError",
)<{
  readonly message: string;
}> {}

export class PullRequestCommandError extends Data.TaggedError("PullRequestCommandError")<{
  readonly message: string;
  readonly sandboxId: string;
  readonly cwd: string;
  readonly cause: unknown;
}> {}

export class GitHubPullRequestApiError extends Data.TaggedError("GitHubPullRequestApiError")<{
  readonly message: string;
  readonly operation: "branchLookup" | "pullRequestLookup" | "pullRequestCreate";
  readonly repository: string;
  readonly statusCode?: number;
  readonly cause?: unknown;
}> {}

export type CreateGitHubPullRequestError =
  | InvalidPullRequestOptionsError
  | PullRequestCommandError
  | GitHubPullRequestApiError;
