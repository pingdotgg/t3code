/**
 * GitHostingCli - Effect service contract for git hosting provider CLI interactions.
 *
 * Provides a provider-agnostic interface for pull/merge request operations,
 * backed by hosting-specific CLIs (e.g. GitHub `gh`, GitLab `glab`).
 *
 * @module GitHostingCli
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { GitHostingPlatform } from "@t3tools/contracts";

import type { ProcessRunResult } from "../../processRunner";
import type { GitHostingCliError } from "../Errors.ts";

export interface PullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state?: "open" | "closed" | "merged";
  readonly updatedAt?: string | null;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

export interface RepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

/**
 * GitHostingCliShape - Service API for executing git hosting CLI commands.
 *
 * Each method is intentionally hosting-agnostic so that GitHub (`gh`) and
 * GitLab (`glab`) implementations can be swapped transparently.
 */
export interface GitHostingCliShape {
  /**
   * Execute a hosting CLI command and return full process output.
   */
  readonly execute: (input: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs?: number;
  }) => Effect.Effect<ProcessRunResult, GitHostingCliError>;

  /**
   * List open pull/merge requests for a head branch.
   */
  readonly listOpenPullRequests: (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<PullRequestSummary>, GitHostingCliError>;

  /**
   * List pull/merge requests across all states for a head branch.
   * Used to find the latest PR/MR (open, closed, or merged) for status display.
   */
  readonly listPullRequests: (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly state: "open" | "closed" | "merged" | "all";
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<PullRequestSummary>, GitHostingCliError>;

  /**
   * Resolve a pull/merge request by URL, number, or branch-ish identifier.
   */
  readonly getPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<PullRequestSummary, GitHostingCliError>;

  /**
   * Resolve clone URLs for a repository.
   */
  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly repository: string;
  }) => Effect.Effect<RepositoryCloneUrls, GitHostingCliError>;

  /**
   * Create a pull/merge request from branch context and body file.
   */
  readonly createPullRequest: (input: {
    readonly cwd: string;
    readonly baseBranch: string;
    readonly headSelector: string;
    readonly title: string;
    readonly bodyFile: string;
  }) => Effect.Effect<void, GitHostingCliError>;

  /**
   * Resolve repository default branch through hosting metadata.
   */
  readonly getDefaultBranch: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string | null, GitHostingCliError>;

  /**
   * Checkout a pull/merge request into the current repository worktree.
   */
  readonly checkoutPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly force?: boolean;
  }) => Effect.Effect<void, GitHostingCliError>;

  /**
   * Return the detected hosting platform for the given repository.
   * Synchronous — the result is cached after first detection.
   */
  readonly getHostingPlatform: (cwd: string) => GitHostingPlatform;

  /**
   * Check whether the hosting CLI (gh/glab) is authenticated.
   * Synchronous with short-lived caching. Returns `true` when authenticated,
   * `false` when not, or `null` when the status cannot be determined
   * (e.g. CLI not installed, timed out).
   */
  readonly checkAuthStatus: (cwd: string) => boolean | null;
}

/**
 * GitHostingCli - Service tag for git hosting CLI operations.
 */
export class GitHostingCli extends ServiceMap.Service<GitHostingCli, GitHostingCliShape>()(
  "t3/git/Services/GitHostingCli",
) {}
