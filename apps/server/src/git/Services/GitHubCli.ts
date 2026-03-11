/**
 * GitHubCli - Effect service contract for `gh` process interactions.
 *
 * Provides thin command execution helpers used by Git workflow orchestration.
 *
 * @module GitHubCli
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProcessRunResult } from "../../processRunner";
import type { GitHubCliError } from "../Errors.ts";

export interface GitHubPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state?: "open" | "closed" | "merged";
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

export interface GitHubRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export interface GitHubAuthAccount {
  readonly state: string;
  readonly active: boolean;
  readonly host: string;
  readonly login: string | null;
  readonly tokenSource: string | null;
  readonly scopes: ReadonlyArray<string>;
  readonly gitProtocol: "https" | "ssh" | null;
}

export interface GitHubRepositorySummary {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly description: string | null;
  readonly defaultBranch: string | null;
}

export interface GitHubIssueSummary {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly labels: ReadonlyArray<{
    readonly name: string;
    readonly color: string | null;
  }>;
  readonly assignees: ReadonlyArray<{
    readonly login: string;
  }>;
  readonly author: string | null;
}

/**
 * GitHubCliShape - Service API for executing GitHub CLI commands.
 */
export interface GitHubCliShape {
  /**
   * Execute a GitHub CLI command and return full process output.
   */
  readonly execute: (input: {
    readonly cwd?: string;
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs?: number;
  }) => Effect.Effect<ProcessRunResult, GitHubCliError>;

  /**
   * List open pull requests for a head branch.
   */
  readonly listOpenPullRequests: (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, GitHubCliError>;

  /**
   * Resolve a pull request by URL, number, or branch-ish identifier.
   */
  readonly getPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<GitHubPullRequestSummary, GitHubCliError>;

  /**
   * Resolve clone URLs for a GitHub repository.
   */
  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly repository: string;
  }) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

  /**
   * Checkout a pull request into the current repository worktree.
   */
  readonly checkoutPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly force?: boolean;
  }) => Effect.Effect<void, GitHubCliError>;

  /**
   * Create a pull request from branch context and body file.
   */
  readonly createPullRequest: (input: {
    readonly cwd: string;
    readonly baseBranch: string;
    readonly headSelector: string;
    readonly title: string;
    readonly bodyFile: string;
  }) => Effect.Effect<void, GitHubCliError>;

  /**
   * Resolve repository default branch through GitHub metadata.
   */
  readonly getDefaultBranch: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string | null, GitHubCliError>;

  /**
   * Read GitHub CLI auth state for a host.
   */
  readonly getAuthStatus: (input?: {
    readonly hostname?: string;
    readonly cwd?: string;
  }) => Effect.Effect<GitHubAuthAccount | null, GitHubCliError>;

  /**
   * Start the browser based GitHub auth flow.
   */
  readonly loginWithBrowser: (input?: {
    readonly hostname?: string;
    readonly gitProtocol?: "https" | "ssh";
    readonly cwd?: string;
  }) => Effect.Effect<void, GitHubCliError>;

  /**
   * Resolve repository metadata from cwd or an explicit repository selector.
   */
  readonly getRepository: (input: {
    readonly cwd?: string;
    readonly repo?: string;
  }) => Effect.Effect<GitHubRepositorySummary | null, GitHubCliError>;

  /**
   * List issues for the repository resolved from cwd or an explicit repository selector.
   */
  readonly listIssues: (input: {
    readonly cwd?: string;
    readonly repo?: string;
    readonly state?: "open" | "closed" | "all";
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<GitHubIssueSummary>, GitHubCliError>;
}

/**
 * GitHubCli - Service tag for GitHub CLI process execution.
 */
export class GitHubCli extends ServiceMap.Service<GitHubCli, GitHubCliShape>()(
  "t3/git/Services/GitHubCli",
) {}
