/**
 * GitService - Service for Git command execution.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and exposes typed
 * domain errors for Git command execution.
 *
 * @module GitService
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { GitCommandError } from "../Errors.ts";

export interface ExecuteGitInput {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface ExecuteGitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * GitServiceShape - Service API for Git command execution.
 */
export interface GitServiceShape {
  /**
   * Execute a Git command.
   */
  readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>;
}

/**
 * GitService - Service for Git command execution.
 */
export class GitService extends ServiceMap.Service<GitService, GitServiceShape>()(
  "git/GitService",
) {}
