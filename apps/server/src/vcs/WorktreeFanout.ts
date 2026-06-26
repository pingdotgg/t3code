/**
 * WorktreeFanout - create/remove one worktree per repo root for isolated runs.
 *
 * A multi-repo thread's isolated run fans out across every repo root (decision
 * D3 / Phase 4): one worktree per root, grouped under a per-thread directory
 * `<worktreesDir>/<projectId>/<threadId>/<repoName>`. Creation is transactional
 * — if any root fails, the worktrees created so far are removed before the error
 * propagates, so a partial fan-out never leaks orphaned worktrees.
 *
 * The git operations are injected (`createWorktree` / `removeWorktree`) so the
 * fan-out policy and its rollback are unit-testable without a real repository.
 *
 * @module WorktreeFanout
 */
import * as Effect from "effect/Effect";

import type {
  GitCommandError,
  OrchestrationThreadWorktree,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsRemoveWorktreeInput,
} from "@t3tools/contracts";

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

export interface WorktreeFanoutDeps {
  readonly createWorktree: (
    input: VcsCreateWorktreeInput,
  ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
  readonly removeWorktree: (input: VcsRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>;
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
export const removeThreadWorktrees = (
  deps: WorktreeFanoutDeps,
  input: {
    readonly worktrees: ReadonlyArray<OrchestrationThreadWorktree>;
    readonly force?: boolean;
  },
): Effect.Effect<void, GitCommandError> =>
  Effect.forEach(
    input.worktrees,
    (worktree) =>
      deps.removeWorktree({
        cwd: worktree.repoRoot,
        path: worktree.worktreePath,
        ...(input.force === undefined ? {} : { force: input.force }),
      }),
    { concurrency: 1, discard: true },
  );

/**
 * Create one worktree per target, transactionally. On the first failure every
 * worktree created so far is force-removed before the original error
 * propagates, so callers never observe a partially-fanned-out thread.
 */
export const createThreadWorktrees = (
  deps: WorktreeFanoutDeps,
  input: CreateThreadWorktreesInput,
): Effect.Effect<ReadonlyArray<CreatedThreadWorktree>, GitCommandError> =>
  Effect.gen(function* () {
    const created: CreatedThreadWorktree[] = [];
    const takenNames = new Set<string>();

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
          const result = yield* deps.createWorktree({
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
        }),
      { concurrency: 1, discard: true },
    ).pipe(
      Effect.catch((error) =>
        // Roll back the worktrees created before the failure, then re-raise the
        // original error. Rollback failures are swallowed so the caller sees the
        // root cause rather than a cleanup error.
        removeThreadWorktrees(deps, { worktrees: created, force: true }).pipe(
          Effect.ignore,
          Effect.andThen(Effect.fail(error)),
        ),
      ),
    );

    return created;
  });
