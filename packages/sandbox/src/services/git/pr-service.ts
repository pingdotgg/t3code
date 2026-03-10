import type { Sandbox } from "@daytonaio/sdk";
import type * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";

import type { GitHubRepository } from "./repo.service";
import type { CreateGitHubPullRequestError } from "./pr-service.errors";

export interface CreateGitHubPullRequestOptions {
  readonly sandbox: Sandbox;
  readonly worktreePath: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly githubRepository: GitHubRepository;
  readonly githubToken: string;
  readonly title: string;
  readonly body?: string;
  readonly draft?: boolean;
}

export interface DeferredGitHubPullRequestResult {
  readonly status: "deferred_no_changes";
  readonly baseBranch: string;
  readonly headBranch: string;
}

export interface CreatedGitHubPullRequestResult {
  readonly status: "created";
  readonly url: string;
  readonly number: number;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly title: string;
}

export interface ExistingGitHubPullRequestResult {
  readonly status: "opened_existing";
  readonly url: string;
  readonly number: number;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly title: string;
}

export type GitHubPullRequestResult =
  | DeferredGitHubPullRequestResult
  | CreatedGitHubPullRequestResult
  | ExistingGitHubPullRequestResult;

export interface PrServiceShape {
  readonly createPullRequest: (
    options: CreateGitHubPullRequestOptions,
  ) => Effect.Effect<GitHubPullRequestResult, CreateGitHubPullRequestError>;
}

export class PrService extends ServiceMap.Service<PrService, PrServiceShape>()(
  "@repo/sandbox/services/git/PrService",
) {}
