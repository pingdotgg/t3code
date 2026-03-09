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

import type { ProcessRunResult } from "../../processRunner";
import type { GitHostingCliError } from "../Errors.ts";

export interface PullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
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
    readonly headBranch: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<PullRequestSummary>, GitHostingCliError>;

  /**
   * Create a pull/merge request from branch context and body file.
   */
  readonly createPullRequest: (input: {
    readonly cwd: string;
    readonly baseBranch: string;
    readonly headBranch: string;
    readonly title: string;
    readonly bodyFile: string;
  }) => Effect.Effect<void, GitHostingCliError>;

  /**
   * Resolve repository default branch through hosting metadata.
   */
  readonly getDefaultBranch: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string | null, GitHostingCliError>;
}

/**
 * GitHostingCli - Service tag for git hosting CLI operations.
 */
export class GitHostingCli extends ServiceMap.Service<GitHostingCli, GitHostingCliShape>()(
  "t3/git/Services/GitHostingCli",
) {}
