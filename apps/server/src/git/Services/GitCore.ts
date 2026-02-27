/**
 * GitCore - Effect service contract for low-level Git operations.
 *
 * Wraps core repository primitives used by higher-level orchestration
 * services and WebSocket routes.
 *
 * @module GitCore
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type {
  GitCheckoutInput,
  GitCreateBranchInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitStatusInput,
  GitStatusResult,
} from "@t3tools/contracts";

import type { GitCommandError } from "../Errors.ts";

export interface GitStatusDetails extends Omit<GitStatusResult, "openPr"> {
  upstreamRef: string | null;
}

export interface GitPreparedCommitContext {
  stagedSummary: string;
  stagedPatch: string;
}

export interface GitPushResult {
  status: "pushed" | "skipped_up_to_date";
  branch: string;
  upstreamBranch?: string | undefined;
  setUpstream?: boolean | undefined;
}

export interface GitRangeContext {
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
}

/**
 * GitCoreShape - Service API for low-level Git repository interactions.
 */
export interface GitCoreShape {
  /**
   * Read Git status for a repository.
   */
  readonly status: (input: GitStatusInput) => Effect.Effect<GitStatusResult, GitCommandError>;

  /**
   * Read detailed working tree / branch status for a repository.
   */
  readonly statusDetails: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;

  /**
   * Build staged change context for commit generation.
   */
  readonly prepareCommitContext: (
    cwd: string,
  ) => Effect.Effect<GitPreparedCommitContext | null, GitCommandError>;

  /**
   * Create a commit with provided subject/body.
   */
  readonly commit: (
    cwd: string,
    subject: string,
    body: string,
  ) => Effect.Effect<{ commitSha: string }, GitCommandError>;

  /**
   * Push current branch, setting upstream if needed.
   */
  readonly pushCurrentBranch: (
    cwd: string,
    fallbackBranch: string | null,
  ) => Effect.Effect<GitPushResult, GitCommandError>;

  /**
   * Collect commit/diff context between base branch and current HEAD.
   */
  readonly readRangeContext: (
    cwd: string,
    baseBranch: string,
  ) => Effect.Effect<GitRangeContext, GitCommandError>;

  /**
   * Read a Git config value from the local repository.
   */
  readonly readConfigValue: (
    cwd: string,
    key: string,
  ) => Effect.Effect<string | null, GitCommandError>;

  /**
   * List local branches and branch metadata.
   */
  readonly listBranches: (
    input: GitListBranchesInput,
  ) => Effect.Effect<GitListBranchesResult, GitCommandError>;

  /**
   * Pull current branch from upstream using fast-forward only.
   */
  readonly pullCurrentBranch: (cwd: string) => Effect.Effect<GitPullResult, GitCommandError>;

  /**
   * Create a worktree and branch from a base branch.
   */
  readonly createWorktree: (
    input: GitCreateWorktreeInput,
  ) => Effect.Effect<GitCreateWorktreeResult, GitCommandError>;

  /**
   * Remove an existing worktree.
   */
  readonly removeWorktree: (input: GitRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>;

  /**
   * Create a local branch.
   */
  readonly createBranch: (input: GitCreateBranchInput) => Effect.Effect<void, GitCommandError>;

  /**
   * Checkout an existing branch and refresh its upstream metadata in background.
   */
  readonly checkoutBranch: (input: GitCheckoutInput) => Effect.Effect<void, GitCommandError>;

  /**
   * Initialize a repository in the provided directory.
   */
  readonly initRepo: (input: GitInitInput) => Effect.Effect<void, GitCommandError>;
}

/**
 * GitCore - Service tag for low-level Git repository operations.
 */
export class GitCore extends ServiceMap.Service<GitCore, GitCoreShape>()(
  "t3/git/Services/GitCore",
) {}
