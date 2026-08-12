/**
 * WorktreeFanout - create/remove one worktree per repo root for isolated runs.
 *
 * A multi-repo thread's isolated run fans out across every repo root: one
 * worktree per root, grouped under a per-thread directory
 * `<worktreesDir>/<projectId>/<threadId>/<repoName>`. Creation is transactional
 * — if any root fails, the worktrees created so far are removed before the error
 * propagates, so a partial fan-out never leaks orphaned worktrees.
 *
 * @module WorktreeFanout
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";

import type { GitCommandError, OrchestrationThreadWorktree } from "@t3tools/contracts";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";

/** A single repo root to materialize a worktree for. */
export interface WorktreeFanoutTarget {
  /** The original repo root the worktree branches from (used as git cwd). */
  readonly repoRoot: string;
  /** The ref/commit-ish the worktree checks out (e.g. the repo's base branch). */
  readonly baseRef: string;
  /** New branch to create in the worktree, or null to detach onto `baseRef`. */
  readonly newBranch: string | null;
}

/** A worktree materialized by the fan-out, keyed by its origin repo root. */
export interface CreatedThreadWorktree {
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly refName: string;
}

export interface CreateThreadWorktreesInput {
  readonly worktreesDir: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly targets: ReadonlyArray<WorktreeFanoutTarget>;
}

/** Final path segment, tolerating either separator and trailing slashes. */
function basenameOf(input: string): string {
  const normalized = input.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return separatorIndex === -1 ? normalized : normalized.slice(separatorIndex + 1);
}

function repoNameOf(repoRoot: string): string {
  const base = basenameOf(repoRoot);
  return base.length > 0 ? base : "repo";
}

/** Join path segments with a forward slash (git accepts these on every OS). */
function joinPath(...segments: ReadonlyArray<string>): string {
  return segments
    .map((segment, index) =>
      index === 0 ? segment.replace(/[\\/]+$/, "") : segment.replace(/^[\\/]+|[\\/]+$/g, ""),
    )
    .filter((segment) => segment.length > 0)
    .join("/");
}

/**
 * Compute the on-disk placement for a thread's per-root worktree:
 * `<worktreesDir>/<projectId>/<threadId>/<repoName>`. When two roots share a
 * basename (e.g. nested `app` folders) the later one is disambiguated with an
 * index suffix so each worktree lands in its own directory.
 */
export function worktreePlacement(input: {
  readonly worktreesDir: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly repoRoot: string;
  readonly takenNames?: ReadonlySet<string>;
}): string {
  const base = repoNameOf(input.repoRoot);
  let name = base;
  let suffix = 2;
  while (input.takenNames?.has(name)) {
    name = `${base}-${suffix}`;
    suffix += 1;
  }
  return joinPath(input.worktreesDir, input.projectId, input.threadId, name);
}

/** Remove a set of fanned-out worktrees. Best-effort: removals run for every
 * entry and only the first failure (if any) is surfaced. */
export const removeThreadWorktrees = (input: {
  readonly worktrees: ReadonlyArray<OrchestrationThreadWorktree>;
  readonly force?: boolean;
}): Effect.Effect<void, GitCommandError, GitWorkflowService.GitWorkflowService> =>
  Effect.gen(function* () {
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const results = yield* Effect.forEach(
      input.worktrees,
      (worktree) =>
        gitWorkflow
          .removeWorktree({
            cwd: worktree.repoRoot,
            path: worktree.worktreePath,
            ...(input.force === undefined ? {} : { force: input.force }),
          })
          .pipe(Effect.result),
      { concurrency: 1 },
    );
    const firstFailure = results.find(Result.isFailure);
    if (firstFailure) return yield* firstFailure.failure;
  });

/**
 * Create one worktree per target, transactionally. On the first failure every
 * worktree created so far is force-removed before the original error
 * propagates, so callers never observe a partially-fanned-out thread.
 */
export const createThreadWorktrees = (
  input: CreateThreadWorktreesInput,
): Effect.Effect<
  ReadonlyArray<CreatedThreadWorktree>,
  GitCommandError,
  GitWorkflowService.GitWorkflowService
> =>
  Effect.gen(function* () {
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const created: CreatedThreadWorktree[] = [];
    const createdBranches: Array<{ readonly repoRoot: string; readonly branch: string }> = [];
    const takenNames = new Set<string>();

    const rollback = Effect.gen(function* () {
      yield* removeThreadWorktrees({ worktrees: created, force: true }).pipe(Effect.ignore);
      yield* Effect.forEach(
        createdBranches,
        ({ repoRoot, branch }) =>
          gitWorkflow.deleteBranch({ cwd: repoRoot, branch }).pipe(Effect.ignore),
        { concurrency: 1, discard: true },
      );
    });

    yield* Effect.forEach(
      input.targets,
      (target) =>
        Effect.gen(function* () {
          const worktreePath = worktreePlacement({
            worktreesDir: input.worktreesDir,
            projectId: input.projectId,
            threadId: input.threadId,
            repoRoot: target.repoRoot,
            takenNames,
          });
          takenNames.add(basenameOf(worktreePath));
          const result = yield* gitWorkflow.createWorktree({
            cwd: target.repoRoot,
            refName: target.baseRef,
            ...(target.newBranch ? { newRefName: target.newBranch } : {}),
            path: worktreePath,
          });
          created.push({
            repoRoot: target.repoRoot,
            worktreePath: result.worktree.path,
            refName: result.worktree.refName,
          });
          if (target.newBranch) {
            createdBranches.push({ repoRoot: target.repoRoot, branch: target.newBranch });
          }
        }),
      { concurrency: 1, discard: true },
    ).pipe(
      // `onExit` covers typed failures, defects, and interruption. Cleanup
      // failures are ignored so the original exit remains authoritative.
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : rollback)),
    );

    return created;
  });
