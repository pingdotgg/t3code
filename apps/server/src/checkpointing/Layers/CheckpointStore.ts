/**
 * CheckpointStoreLive - Filesystem checkpoint store adapter layer.
 *
 * Implements hidden Git-ref checkpoint capture/restore directly with
 * Effect-native child process execution (`effect/unstable/process`).
 *
 * This layer owns filesystem/Git interactions only; it does not persist
 * checkpoint metadata and does not coordinate provider rollback semantics.
 *
 * @module CheckpointStoreLive
 */
import { randomUUID } from "node:crypto";
import nodePath from "node:path";

import { Cache, Data, Duration, Effect, Exit, Layer, FileSystem, Option, Path } from "effect";

import { CheckpointInvariantError, CheckpointRefUnavailableError } from "../Errors.ts";
import { GitCommandError } from "@t3tools/contracts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { CheckoutCoordinator, CheckoutCoordinatorLive } from "../../git/CheckoutCoordinator.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { CheckpointRef, type WorkspaceBinding } from "@t3tools/contracts";
import { normalizeChangedFilePath } from "@t3tools/shared/toolChangedFiles";
import {
  parseTurnDiffFilesFromNumstat,
  parseTurnDiffFileStatusesFromNameStatus,
} from "../Diffs.ts";

const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;
const CHECKPOINT_DIFF_NUMSTAT_MAX_OUTPUT_BYTES = 10_000_000;
const CHECKPOINT_DIFF_CACHE_CAPACITY = 128;
const CHECKPOINT_DIFF_CACHE_MAX_STRING_BYTES = 32 * 1024 * 1024;
const CHECKPOINT_DIFF_CACHE_MAX_ENTRY_STRING_BYTES =
  CHECKPOINT_DIFF_CACHE_MAX_STRING_BYTES / CHECKPOINT_DIFF_CACHE_CAPACITY;
const CHECKPOINT_DIFF_CACHE_TTL = Duration.minutes(5);

class CheckpointDiffCacheKey extends Data.Class<{
  readonly cwd: string;
  readonly fromCommitOid: string;
  readonly toCommitOid: string;
  readonly ignoreWhitespace: boolean;
  readonly paths: ReadonlyArray<string>;
}> {}

class CheckpointDiffFilesCacheKey extends Data.Class<{
  readonly cwd: string;
  readonly fromCommitOid: string;
  readonly toCommitOid: string;
  readonly paths: ReadonlyArray<string>;
}> {}

/** Bounded by entry count only: file-stat lists are small and keys are immutable projected OIDs. */
const CHECKPOINT_DIFF_FILES_CACHE_CAPACITY = 128;
const CHECKPOINT_DIFF_FILES_CACHE_TTL = Duration.minutes(5);

/**
 * Bounds the history walk used to separate turn-authored commits from base
 * movement. Threads that move their base by more than this fall back to a
 * plain checkpoint-to-checkpoint diff.
 */
const BASE_MOVEMENT_MAX_COMMITS = 1000;
const BASE_PROJECTION_CACHE_MAX_ENTRIES = 128;
// Short TTL: the projection also reads mutable ref state outside the cache key.
const BASE_PROJECTION_CACHE_TTL = Duration.seconds(5);

/** Reflog subjects for operations that move a workspace onto history it did not author (branch switches and hard resets included; both degrade to a plain diff without a foreign base). */
const BASE_MOVING_REFLOG_OPERATIONS = /^(rebase|merge|pull|checkout|reset)\b/;

class BaseProjectionCacheKey extends Data.Class<{
  readonly cwd: string;
  readonly fromCommitOid: string;
  readonly toCommitOid: string;
}> {}

function parseCommitOids(stdout: string): ReadonlyArray<string> {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const makeCheckpointStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitCore;
  const coordinator = yield* CheckoutCoordinator;

  const executeCheckpointDiff = Effect.fn("executeCheckpointDiff")((key: CheckpointDiffCacheKey) =>
    git
      .execute({
        operation: "CheckpointStore.diffCheckpoints",
        cwd: key.cwd,
        args: [
          "diff",
          "--patch",
          "--minimal",
          "--no-color",
          "--find-renames",
          "--find-copies",
          ...(key.ignoreWhitespace ? ["--ignore-all-space"] : []),
          key.fromCommitOid,
          key.toCommitOid,
          ...(key.paths.length > 0 ? ["--", ...key.paths] : []),
        ],
        maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      })
      .pipe(Effect.map((result) => result.stdout)),
  );
  const checkpointDiffCache = yield* Cache.makeWith(executeCheckpointDiff, {
    capacity: CHECKPOINT_DIFF_CACHE_CAPACITY,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) && exit.value.length * 2 <= CHECKPOINT_DIFF_CACHE_MAX_ENTRY_STRING_BYTES
        ? CHECKPOINT_DIFF_CACHE_TTL
        : Duration.zero,
  });

  const resolveHeadCommit = (cwd: string): Effect.Effect<string | null, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.resolveHeadCommit",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          const commit = result.stdout.trim();
          return commit.length > 0 ? commit : null;
        }),
      );

  const hasHeadCommit = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.hasHeadCommit",
        cwd,
        args: ["rev-parse", "--verify", "HEAD"],
        allowNonZeroExit: true,
      })
      .pipe(Effect.map((result) => result.code === 0));

  const resolveCheckpointCommit = (
    cwd: string,
    checkpointRef: CheckpointRef,
  ): Effect.Effect<string | null, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.resolveCheckpointCommit",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          const commit = result.stdout.trim();
          return commit.length > 0 ? commit : null;
        }),
      );

  const resolveWorktreeRoot = (cwd: string): Effect.Effect<string, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.resolveWorktreeRoot",
        cwd,
        args: ["rev-parse", "--show-toplevel"],
      })
      .pipe(Effect.map((result) => result.stdout.trim()));

  const foreignNestedWorktreeExclusions = Effect.fn("foreignNestedWorktreeExclusions")(function* (
    cwd: string,
  ) {
    const root = yield* resolveWorktreeRoot(cwd);
    const result = yield* git.execute({
      operation: "CheckpointStore.foreignNestedWorktreeExclusions",
      cwd,
      args: ["worktree", "list", "--porcelain"],
    });
    const exclusions: string[] = [];
    for (const line of result.stdout.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const candidate = line.slice("worktree ".length).trim();
      const relative = nodePath.relative(root, candidate);
      if (
        relative.length > 0 &&
        relative !== ".." &&
        !relative.startsWith(`..${nodePath.sep}`) &&
        !nodePath.isAbsolute(relative)
      ) {
        const normalized = relative.split(nodePath.sep).join("/");
        exclusions.push(`:(exclude)${normalized}`, `:(exclude)${normalized}/**`);
      }
    }
    return exclusions;
  });

  const foreignNestedWorktreePaths = Effect.fn("foreignNestedWorktreePaths")(function* (
    cwd: string,
  ) {
    const root = yield* resolveWorktreeRoot(cwd);
    const result = yield* git.execute({
      operation: "CheckpointStore.foreignNestedWorktreePaths",
      cwd,
      args: ["worktree", "list", "--porcelain"],
    });
    return result.stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim())
      .map((candidate) => nodePath.relative(root, candidate))
      .filter(
        (relative) =>
          relative.length > 0 &&
          relative !== ".." &&
          !relative.startsWith(`..${nodePath.sep}`) &&
          !nodePath.isAbsolute(relative),
      )
      .map((relative) => relative.split(nodePath.sep).join("/"));
  });

  const checkpointHasForeignNestedWorktreeEntries = Effect.fn(
    "checkpointHasForeignNestedWorktreeEntries",
  )(function* (cwd: string, commitOid: string) {
    const [foreignPaths, tree] = yield* Effect.all(
      [
        foreignNestedWorktreePaths(cwd),
        git.execute({
          operation: "CheckpointStore.checkpointForeignNestedWorktreeEntries",
          cwd,
          args: ["ls-tree", "-r", "--name-only", commitOid],
        }),
      ],
      { concurrency: "unbounded" },
    );
    const entries = tree.stdout.split("\n").filter((entry) => entry.length > 0);
    return foreignPaths.some((foreignPath) =>
      entries.some((entry) => entry === foreignPath || entry.startsWith(`${foreignPath}/`)),
    );
  });

  const isGitRepository: CheckpointStoreShape["isGitRepository"] = (cwd) =>
    git
      .execute({
        operation: "CheckpointStore.isGitRepository",
        cwd,
        args: ["rev-parse", "--is-inside-work-tree"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => result.code === 0 && result.stdout.trim() === "true"),
        Effect.catch(() => Effect.succeed(false)),
      );

  /**
   * Seed a scratch index with a copy of the worktree's own index so `git add -A`
   * reuses its cached stat data and hashes only changed files. A `read-tree`
   * seed has no stat data, which forces a re-hash of every tracked file per
   * snapshot. The copy keeps the source mtime because racy-git detection compares
   * entry mtimes against the index file's own mtime. Returns false when there is
   * no index to copy, so the caller falls back to `read-tree HEAD`.
   */
  const seedIndexFromWorktree = Effect.fn("seedIndexFromWorktree")(function* (
    cwd: string,
    tempIndexPath: string,
  ) {
    const result = yield* git.execute({
      operation: "CheckpointStore.seedIndexFromWorktree",
      cwd,
      args: ["rev-parse", "--git-path", "index"],
      allowNonZeroExit: true,
    });
    const relativeIndexPath = result.stdout.trim();
    if (result.code !== 0 || relativeIndexPath.length === 0) return false;
    const indexPath = path.resolve(cwd, relativeIndexPath);
    return yield* Effect.gen(function* () {
      const info = yield* fs.stat(indexPath);
      yield* fs.copyFile(indexPath, tempIndexPath);
      const mtime = Option.getOrElse(info.mtime, () => new Date(0));
      yield* fs.utimes(
        tempIndexPath,
        Option.getOrElse(info.atime, () => mtime),
        mtime,
      );
      return true;
    }).pipe(
      Effect.catchTag("PlatformError", () =>
        fs.remove(tempIndexPath, { force: true }).pipe(Effect.ignore, Effect.as(false)),
      ),
    );
  });

  const snapshotWorkspace = Effect.fn("snapshotWorkspace")(function* (input: {
    readonly cwd: string;
    readonly operation: string;
  }) {
    return yield* coordinator
      .withCheckout(
        input.cwd,
        Effect.acquireUseRelease(
          fs.makeTempDirectory({ prefix: "t3-fs-checkpoint-" }),
          Effect.fn("snapshotWorkspace.withTempDirectory")(function* (tempDir) {
            const tempIndexPath = path.join(tempDir, `index-${randomUUID()}`);
            const env: NodeJS.ProcessEnv = {
              ...process.env,
              GIT_INDEX_FILE: tempIndexPath,
            };
            const [headCommit, seededFromIndex, exclusions] = yield* Effect.all(
              [
                resolveHeadCommit(input.cwd),
                seedIndexFromWorktree(input.cwd, tempIndexPath),
                foreignNestedWorktreeExclusions(input.cwd),
              ],
              { concurrency: "unbounded" },
            );
            if (!seededFromIndex && headCommit !== null) {
              yield* git.execute({
                operation: input.operation,
                cwd: input.cwd,
                args: ["read-tree", "HEAD"],
                env,
              });
            }
            yield* git.execute({
              operation: input.operation,
              cwd: input.cwd,
              args: ["add", "-A", "--", ".", ...exclusions],
              env,
            });
            const writeTreeResult = yield* git.execute({
              operation: input.operation,
              cwd: input.cwd,
              args: ["write-tree"],
              env,
            });
            const treeOid = writeTreeResult.stdout.trim();
            if (treeOid.length === 0) {
              return yield* new GitCommandError({
                operation: input.operation,
                command: "git write-tree",
                cwd: input.cwd,
                detail: "git write-tree returned an empty tree oid.",
              });
            }
            const indexTreeResult = yield* git.execute({
              operation: input.operation,
              cwd: input.cwd,
              args: ["write-tree"],
            });
            const indexTreeOid = indexTreeResult.stdout.trim();
            if (indexTreeOid.length === 0) {
              return yield* new GitCommandError({
                operation: input.operation,
                command: "git write-tree",
                cwd: input.cwd,
                detail: "git write-tree returned an empty index tree oid.",
              });
            }
            return { headCommit, treeOid, indexTreeOid };
          }),
          (tempDir) => fs.remove(tempDir, { recursive: true }),
        ),
      )
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(
            new CheckpointInvariantError({
              operation: input.operation,
              detail: "Failed to snapshot workspace.",
              cause: error,
            }),
          ),
        ),
      );
  });

  const captureCheckpoint: CheckpointStoreShape["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    const operation = "CheckpointStore.captureCheckpoint";
    const { headCommit, treeOid, indexTreeOid } = yield* snapshotWorkspace({
      cwd: input.cwd,
      operation,
    });
    const worktreeRoot = yield* resolveWorktreeRoot(input.cwd);
    const message = [
      `t3 checkpoint ref=${input.checkpointRef}`,
      "",
      `t3-worktree=${worktreeRoot}`,
      `t3-index-tree=${indexTreeOid}`,
      ...(input.workspaceBinding === undefined
        ? []
        : [
            `t3-workspace-canonical=${input.workspaceBinding.canonicalPath}`,
            `t3-workspace-generation=${input.workspaceBinding.generation}`,
          ]),
    ].join("\n");
    const commitTreeResult = yield* git.execute({
      operation,
      cwd: input.cwd,
      args: [
        "commit-tree",
        treeOid,
        ...(headCommit !== null ? ["-p", headCommit] : []),
        "-m",
        message,
      ],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T3 Code",
        GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
        GIT_COMMITTER_NAME: "T3 Code",
        GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
      },
    });
    const commitOid = commitTreeResult.stdout.trim();
    if (commitOid.length === 0) {
      return yield* new GitCommandError({
        operation,
        command: "git commit-tree",
        cwd: input.cwd,
        detail: "git commit-tree returned an empty commit oid.",
      });
    }

    yield* git.execute({
      operation,
      cwd: input.cwd,
      args: ["update-ref", input.checkpointRef, commitOid],
    });
  });

  const hasCheckpointRef: CheckpointStoreShape["hasCheckpointRef"] = (input) =>
    resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
      Effect.map((commit) => commit !== null),
    );

  const checkpointRefMatchesWorkspace: CheckpointStoreShape["checkpointRefMatchesWorkspace"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const checkpointCommit = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);
      if (!checkpointCommit) {
        return false;
      }
      const [worktreeRoot, commitMessage, checkpointHead, checkpointTree, workspace] =
        yield* Effect.all(
          [
            resolveWorktreeRoot(input.cwd),
            git
              .execute({
                operation: "CheckpointStore.checkpointRefMatchesWorkspace",
                cwd: input.cwd,
                args: ["show", "-s", "--format=%B", checkpointCommit],
              })
              .pipe(Effect.map((result) => result.stdout)),
            resolveCommitParent(input.cwd, checkpointCommit),
            git
              .execute({
                operation: "CheckpointStore.checkpointRefMatchesWorkspace",
                cwd: input.cwd,
                args: ["rev-parse", `${checkpointCommit}^{tree}`],
              })
              .pipe(Effect.map((result) => result.stdout.trim())),
            snapshotWorkspace({
              cwd: input.cwd,
              operation: "CheckpointStore.checkpointRefMatchesWorkspace",
            }),
          ],
          { concurrency: "unbounded" },
        );
      return (
        commitMessage.includes(`t3-worktree=${worktreeRoot}\n`) &&
        (input.workspaceBinding === undefined ||
          (commitMessage.includes(
            `t3-workspace-canonical=${input.workspaceBinding.canonicalPath}\n`,
          ) &&
            commitMessage.includes(
              `t3-workspace-generation=${input.workspaceBinding.generation}\n`,
            ))) &&
        checkpointHead === workspace.headCommit &&
        (input.compareContents === false ||
          (checkpointTree === workspace.treeOid &&
            commitMessage.includes(`t3-index-tree=${workspace.indexTreeOid}\n`)))
      );
    });

  const normalizeDiffPaths = (input: {
    readonly cwd: string;
    readonly paths?: ReadonlyArray<string>;
  }): ReadonlyArray<string> | undefined =>
    input.paths
      ?.map((filePath) => normalizeChangedFilePath(filePath, { cwd: input.cwd }))
      .filter((filePath): filePath is string => filePath !== null);

  const resolveCommitParent = (
    cwd: string,
    commit: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.resolveCommitParent",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", `${commit}^`],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          const parent = result.stdout.trim();
          return parent.length > 0 ? parent : null;
        }),
      );

  const resolveCurrentBranch = (cwd: string): Effect.Effect<string | null, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.resolveCurrentBranch",
        cwd,
        args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          const branch = result.stdout.trim();
          return branch.length > 0 ? branch : null;
        }),
      );

  /**
   * Report whether the workspace adopted history it did not author between
   * `fromBaseCommit` and `toBaseCommit`, using the operations Git records in
   * HEAD's reflog.
   *
   * Ref topology alone cannot answer this. A branch forked off an intermediate
   * turn commit and a branch carrying a base the turn rebased onto produce the
   * same shape: an unrelated ref pointing into the first-parent chain above the
   * prior turn's base. Only the reflog distinguishes commits the workspace
   * authored from history a rebase, merge, or pull brought in.
   *
   * The scan is bounded to the turn's own window so an on-demand diff of an
   * older turn cannot observe base movement from a later one, and it must reach
   * both ends of that window to be trusted. A trimmed reflog, or a checkpoint
   * captured in a different worktree, therefore reports no movement and leaves
   * the plain checkpoint-to-checkpoint diff in place.
   */
  const resolveBaseMovement = Effect.fn("resolveBaseMovement")(function* (input: {
    readonly cwd: string;
    readonly fromBaseCommit: string;
    readonly toBaseCommit: string;
  }) {
    const reflogResult = yield* git.execute({
      operation: "CheckpointStore.resolveHeadReflog",
      cwd: input.cwd,
      args: [
        "reflog",
        "show",
        "--no-abbrev",
        "--format=%H %gs",
        `--max-count=${BASE_MOVEMENT_MAX_COMMITS}`,
        "HEAD",
      ],
      allowNonZeroExit: true,
    });
    if (reflogResult.code !== 0) {
      return { baseMoved: false, fastForwardBaseCommit: null };
    }

    let insideTurnWindow = false;
    let baseMoved = false;
    let fastForwardCandidate: string | null = null;
    let expectFromBaseAfterPull = false;
    for (const entry of reflogResult.stdout.split("\n")) {
      const separatorIndex = entry.indexOf(" ");
      if (separatorIndex === -1) {
        continue;
      }
      const commit = entry.slice(0, separatorIndex);
      if (!insideTurnWindow) {
        // Entries above the turn's end belong to later turns.
        insideTurnWindow = commit === input.toBaseCommit;
      }
      if (commit === input.fromBaseCommit) {
        return {
          baseMoved: insideTurnWindow && baseMoved,
          fastForwardBaseCommit:
            insideTurnWindow && expectFromBaseAfterPull ? fastForwardCandidate : null,
        };
      }
      if (!insideTurnWindow) {
        continue;
      }
      const subject = entry.slice(separatorIndex + 1);
      const isPull = /^pull\b/.test(subject);
      if (expectFromBaseAfterPull && !isPull) {
        fastForwardCandidate = null;
        expectFromBaseAfterPull = false;
      }
      // A checkout/reset landing on the turn's end commit returns to the turn; only checkouts inside the window adopt a new base.
      const isReturnToTurnEnd =
        /^(checkout|reset)\b/.test(subject) && commit === input.toBaseCommit;
      if (!isReturnToTurnEnd && BASE_MOVING_REFLOG_OPERATIONS.test(subject)) {
        baseMoved = true;
      }
      if (isPull) {
        fastForwardCandidate ??= commit;
        expectFromBaseAfterPull = true;
      }
    }
    return { baseMoved: false, fastForwardBaseCommit: null };
  });

  /**
   * Resolve the newest commit on `toBaseCommit`'s first-parent chain that also
   * exists on an unrelated branch, i.e. the base the turn's own commits sit on.
   *
   * Two ref families are excluded from "unrelated", because both can point at
   * the turn's own work and would misreport it as base movement:
   * - refs that already contain `toBaseCommit` (stacked branches descending from
   *   this thread's work);
   * - the checked-out branch and its remote-tracking refs, which a mid-turn push
   *   leaves pointing at a commit the turn itself authored.
   *
   * The walk stops at `fromBaseCommit`, since reaching it means every commit
   * above it was authored during the turn. Base movement that arrives on the
   * checked-out branch itself (a same-branch fast-forward pull) is therefore not
   * detected; that case degrades to a plain checkpoint-to-checkpoint diff rather
   * than dropping turn-authored work.
   *
   * A merge keeps the turn's own history as its first parent, so the adopted
   * base is the merge's other parent rather than a commit on the chain.
   */
  const resolveForeignBaseCommit = Effect.fn("resolveForeignBaseCommit")(function* (input: {
    readonly cwd: string;
    readonly fromBaseCommit: string;
    readonly toBaseCommit: string;
  }) {
    const currentBranch = yield* resolveCurrentBranch(input.cwd);
    const unrelatedTipsResult = yield* git.execute({
      operation: "CheckpointStore.resolveUnrelatedRefTips",
      cwd: input.cwd,
      args: [
        "for-each-ref",
        `--no-contains=${input.toBaseCommit}`,
        ...(currentBranch === null
          ? []
          : [`--exclude=refs/heads/${currentBranch}`, `--exclude=refs/remotes/*/${currentBranch}`]),
        "--format=%(objectname)",
        "refs/heads",
        "refs/remotes",
      ],
    });
    const unrelatedTips = Array.from(new Set(parseCommitOids(unrelatedTipsResult.stdout)));
    if (unrelatedTips.length === 0) {
      return null;
    }

    const [chainResult, turnAuthoredResult] = yield* Effect.all(
      [
        git.execute({
          operation: "CheckpointStore.resolveBaseChain",
          cwd: input.cwd,
          args: [
            "rev-list",
            "--parents",
            "--first-parent",
            `--max-count=${BASE_MOVEMENT_MAX_COMMITS}`,
            input.toBaseCommit,
          ],
        }),
        git.execute({
          operation: "CheckpointStore.resolveTurnAuthoredCommits",
          cwd: input.cwd,
          args: [
            "rev-list",
            `--max-count=${BASE_MOVEMENT_MAX_COMMITS}`,
            input.toBaseCommit,
            "--not",
            ...unrelatedTips,
          ],
        }),
      ],
      { concurrency: "unbounded" },
    );

    const turnAuthored = new Set(parseCommitOids(turnAuthoredResult.stdout));
    for (const entry of parseCommitOids(chainResult.stdout)) {
      const [commit, ...parents] = entry.split(" ");
      if (commit === undefined || commit === input.fromBaseCommit) {
        return null;
      }
      if (!turnAuthored.has(commit)) {
        return commit;
      }
      const adoptedParent = parents.slice(1).find((parent) => !turnAuthored.has(parent));
      if (adoptedParent !== undefined) {
        return adoptedParent;
      }
    }
    return null;
  });

  /**
   * Rebase the "from" checkpoint onto the base that the "to" checkpoint was
   * captured against, so a turn diff excludes commits that entered the base
   * during the turn instead of attributing them to the turn.
   *
   * Returns the original checkpoint commit whenever the base did not move or
   * the projection cannot be computed cleanly.
   */
  const resolveBaseProjection = Effect.fn("resolveBaseProjection")(function* (input: {
    readonly cwd: string;
    readonly fromCommitOid: string;
    readonly toCommitOid: string;
  }) {
    const [fromBaseCommit, toBaseCommit] = yield* Effect.all(
      [
        resolveCommitParent(input.cwd, input.fromCommitOid),
        resolveCommitParent(input.cwd, input.toCommitOid),
      ],
      { concurrency: "unbounded" },
    );
    if (fromBaseCommit === null || toBaseCommit === null || fromBaseCommit === toBaseCommit) {
      return input.fromCommitOid;
    }

    const baseMovement = yield* resolveBaseMovement({
      cwd: input.cwd,
      fromBaseCommit,
      toBaseCommit,
    });
    if (!baseMovement.baseMoved) {
      return input.fromCommitOid;
    }

    const newBaseCommit = yield* resolveForeignBaseCommit({
      cwd: input.cwd,
      fromBaseCommit,
      toBaseCommit,
    });
    const projectedBaseCommit = baseMovement.fastForwardBaseCommit ?? newBaseCommit;
    if (projectedBaseCommit === null) {
      return input.fromCommitOid;
    }

    // A rebase leaves `fromBaseCommit` off the new base's history, so it is not
    // a usable merge base: replaying against it would revert earlier turns' work
    // out of the projection. Their common ancestor is equivalent when the base
    // only moved forward, and correct when it was rewritten.
    const mergeBaseResult = yield* git.execute({
      operation: "CheckpointStore.resolveProjectionMergeBase",
      cwd: input.cwd,
      args: ["merge-base", projectedBaseCommit, fromBaseCommit],
      allowNonZeroExit: true,
    });
    if (mergeBaseResult.code !== 0) {
      return input.fromCommitOid;
    }
    const mergeBaseCommit = mergeBaseResult.stdout.trim();
    if (mergeBaseCommit.length === 0) {
      return input.fromCommitOid;
    }

    const mergeResult = yield* git.execute({
      operation: "CheckpointStore.projectFromCheckpointOntoBase",
      cwd: input.cwd,
      args: [
        "merge-tree",
        "--write-tree",
        `--merge-base=${mergeBaseCommit}`,
        projectedBaseCommit,
        input.fromCommitOid,
      ],
      allowNonZeroExit: true,
      maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
    });
    if (mergeResult.code !== 0) {
      return input.fromCommitOid;
    }
    const treeOid = mergeResult.stdout.split("\n")[0]?.trim() ?? "";
    return treeOid.length > 0 ? treeOid : input.fromCommitOid;
  });

  const baseProjectionCache = yield* Cache.makeWith(resolveBaseProjection, {
    capacity: BASE_PROJECTION_CACHE_MAX_ENTRIES,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? BASE_PROJECTION_CACHE_TTL : Duration.zero),
  });

  const projectFromCheckpointOntoBase = Effect.fn("projectFromCheckpointOntoBase")(
    function* (input: {
      readonly cwd: string;
      readonly fromCommitOid: string;
      readonly toCommitOid: string;
    }) {
      return yield* Cache.get(baseProjectionCache, new BaseProjectionCacheKey(input));
    },
  );

  const resolveDiffCommits = Effect.fn("resolveDiffCommits")(function* (input: {
    readonly cwd: string;
    readonly fromCheckpointRef: CheckpointRef;
    readonly fallbackFromCheckpointRef?: CheckpointRef;
    readonly toCheckpointRef: CheckpointRef;
    readonly fallbackFromToHead?: boolean;
    readonly workspaceBinding?: WorkspaceBinding;
  }) {
    const [primaryFromCommitOid, toCommitOid] = yield* Effect.all(
      [
        resolveCheckpointCommit(input.cwd, input.fromCheckpointRef),
        resolveCheckpointCommit(input.cwd, input.toCheckpointRef),
      ],
      { concurrency: "unbounded" },
    );
    let fromCommitOid = primaryFromCommitOid;

    if (
      !fromCommitOid &&
      input.fallbackFromCheckpointRef !== undefined &&
      input.fallbackFromCheckpointRef !== input.fromCheckpointRef
    ) {
      fromCommitOid = yield* resolveCheckpointCommit(input.cwd, input.fallbackFromCheckpointRef);
    }
    const fromCheckpointExists = fromCommitOid !== null;

    if (!fromCommitOid && input.fallbackFromToHead === true) {
      const headCommit = yield* resolveHeadCommit(input.cwd);
      if (headCommit) {
        fromCommitOid = headCommit;
      }
    }

    if (!fromCommitOid) {
      return yield* new CheckpointRefUnavailableError({
        endpoint: "from",
      });
    }
    if (!toCommitOid) {
      return yield* new CheckpointRefUnavailableError({
        endpoint: "to",
      });
    }

    if (input.workspaceBinding !== undefined) {
      const validateCommit = (commitOid: string, endpoint: "from" | "to") =>
        git
          .execute({
            operation: "CheckpointStore.validateDiffCheckpointBinding",
            cwd: input.cwd,
            args: ["show", "-s", "--format=%B", commitOid],
          })
          .pipe(
            Effect.flatMap((result) =>
              result.stdout.includes(
                `t3-workspace-canonical=${input.workspaceBinding!.canonicalPath}\n`,
              ) &&
              result.stdout.includes(
                `t3-workspace-generation=${input.workspaceBinding!.generation}\n`,
              )
                ? Effect.succeed(undefined)
                : Effect.fail(
                    new CheckpointInvariantError({
                      operation: "CheckpointStore.diffCheckpoints",
                      detail: `The ${endpoint} checkpoint does not belong to workspace generation ${input.workspaceBinding!.generation}.`,
                    }),
                  ),
            ),
          );
      if (fromCheckpointExists) yield* validateCommit(fromCommitOid, "from");
      yield* validateCommit(toCommitOid, "to");
    }

    return { fromCommitOid, toCommitOid, fromCheckpointExists };
  });

  const projectDiffCommits = Effect.fn("projectDiffCommits")(function* (input: {
    readonly cwd: string;
    readonly fromCommitOid: string;
    readonly toCommitOid: string;
    readonly fromCheckpointExists: boolean;
  }) {
    if (!input.fromCheckpointExists) {
      return {
        fromCommitOid: input.fromCommitOid,
        toCommitOid: input.toCommitOid,
      };
    }

    const projectedFromOid = yield* projectFromCheckpointOntoBase({
      cwd: input.cwd,
      fromCommitOid: input.fromCommitOid,
      toCommitOid: input.toCommitOid,
    }).pipe(Effect.catch(() => Effect.succeed(input.fromCommitOid)));
    return {
      fromCommitOid: projectedFromOid,
      toCommitOid: input.toCommitOid,
    };
  });

  const restoreCheckpoint: CheckpointStoreShape["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    const operation = "CheckpointStore.restoreCheckpoint";

    const checkpointCommit = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);
    let commitOid = checkpointCommit;

    if (!commitOid && input.fallbackToHead === true) {
      commitOid = yield* resolveHeadCommit(input.cwd);
    }

    if (!commitOid) {
      return false;
    }

    const commitMessage = yield* git
      .execute({
        operation,
        cwd: input.cwd,
        args: ["show", "-s", "--format=%B", commitOid],
      })
      .pipe(Effect.map((result) => result.stdout));
    const worktreeRoot = yield* resolveWorktreeRoot(input.cwd);
    if (checkpointCommit !== null) {
      if (!commitMessage.includes(`t3-worktree=${worktreeRoot}\n`)) {
        return false;
      }
      if (
        input.workspaceBinding !== undefined &&
        (!commitMessage.includes(
          `t3-workspace-canonical=${input.workspaceBinding.canonicalPath}\n`,
        ) ||
          !commitMessage.includes(`t3-workspace-generation=${input.workspaceBinding.generation}\n`))
      ) {
        return false;
      }
      if (yield* checkpointHasForeignNestedWorktreeEntries(input.cwd, commitOid)) {
        return false;
      }
    }
    const exclusions = yield* foreignNestedWorktreeExclusions(input.cwd);
    const indexTreeOid = /^t3-index-tree=([0-9a-f]+)$/m.exec(commitMessage)?.[1];

    yield* git.execute({
      operation,
      cwd: input.cwd,
      args: ["read-tree", "--reset", "-u", commitOid],
    });
    yield* git.execute({
      operation,
      cwd: input.cwd,
      args: ["clean", "-fd", "--", ".", ...exclusions],
    });

    if (indexTreeOid) {
      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["read-tree", indexTreeOid],
      });
    } else {
      const headExists = yield* hasHeadCommit(input.cwd);
      if (headExists) {
        yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["reset", "--quiet", "--", "."],
        });
      }
    }

    return true;
  });

  const diffCheckpoints: CheckpointStoreShape["diffCheckpoints"] = Effect.fn("diffCheckpoints")(
    function* (input) {
      const resolvedCommits = yield* resolveDiffCommits(input);
      const paths = normalizeDiffPaths(input);
      if (input.paths !== undefined && (paths?.length ?? 0) === 0) {
        return "";
      }
      const { fromCommitOid, toCommitOid } = yield* projectDiffCommits({
        cwd: input.cwd,
        ...resolvedCommits,
      });
      const cacheKey = new CheckpointDiffCacheKey({
        cwd: input.cwd,
        fromCommitOid,
        toCommitOid,
        ignoreWhitespace: input.ignoreWhitespace === true,
        paths: paths ?? [],
      });
      if (!resolvedCommits.fromCheckpointExists) {
        return yield* executeCheckpointDiff(cacheKey);
      }
      return yield* Cache.get(checkpointDiffCache, cacheKey).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) &&
          exit.value.length * 2 > CHECKPOINT_DIFF_CACHE_MAX_ENTRY_STRING_BYTES
            ? Cache.invalidateWhen(
                checkpointDiffCache,
                cacheKey,
                (value) => value.length * 2 > CHECKPOINT_DIFF_CACHE_MAX_ENTRY_STRING_BYTES,
              )
            : Effect.void,
        ),
      );
    },
  );

  const executeCheckpointDiffFiles = Effect.fn("executeCheckpointDiffFiles")((
    key: CheckpointDiffFilesCacheKey,
  ) => {
    const pathArgs = key.paths.length > 0 ? ["--", ...key.paths] : [];
    // Keep patch and summary copy detection aligned without scanning unchanged files.
    const similarityArgs = ["--find-renames", "--find-copies"];
    return Effect.all(
      [
        git.execute({
          operation: "CheckpointStore.diffCheckpointFiles",
          cwd: key.cwd,
          args: [
            "diff",
            "--numstat",
            "-z",
            ...similarityArgs,
            key.fromCommitOid,
            key.toCommitOid,
            ...pathArgs,
          ],
          maxOutputBytes: CHECKPOINT_DIFF_NUMSTAT_MAX_OUTPUT_BYTES,
        }),
        git.execute({
          operation: "CheckpointStore.diffCheckpointFiles",
          cwd: key.cwd,
          args: [
            "diff",
            "--name-status",
            "-z",
            ...similarityArgs,
            key.fromCommitOid,
            key.toCommitOid,
            ...pathArgs,
          ],
          maxOutputBytes: CHECKPOINT_DIFF_NUMSTAT_MAX_OUTPUT_BYTES,
        }),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([numstatResult, nameStatusResult]) => {
        const statsByPath = new Map(
          parseTurnDiffFilesFromNumstat(numstatResult.stdout).map(
            (file) => [file.path, file] as const,
          ),
        );
        return parseTurnDiffFileStatusesFromNameStatus(nameStatusResult.stdout).map((file) => {
          const stats = statsByPath.get(file.path);
          return {
            ...file,
            additions: stats?.additions ?? 0,
            deletions: stats?.deletions ?? 0,
          };
        });
      }),
    );
  });
  const checkpointDiffFilesCache = yield* Cache.makeWith(executeCheckpointDiffFiles, {
    capacity: CHECKPOINT_DIFF_FILES_CACHE_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? CHECKPOINT_DIFF_FILES_CACHE_TTL : Duration.zero),
  });

  const diffCheckpointFiles: CheckpointStoreShape["diffCheckpointFiles"] = Effect.fn(
    "diffCheckpointFiles",
  )(function* (input) {
    const resolvedCommits = yield* resolveDiffCommits(input);
    const paths = normalizeDiffPaths(input);
    if (input.paths !== undefined && (paths?.length ?? 0) === 0) {
      return [];
    }
    const { fromCommitOid, toCommitOid } = yield* projectDiffCommits({
      cwd: input.cwd,
      ...resolvedCommits,
    });

    return yield* Cache.get(
      checkpointDiffFilesCache,
      new CheckpointDiffFilesCacheKey({
        cwd: input.cwd,
        fromCommitOid,
        toCommitOid,
        paths: paths ?? [],
      }),
    );
  });

  const deleteCheckpointRefs: CheckpointStoreShape["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    const operation = "CheckpointStore.deleteCheckpointRefs";

    yield* Effect.forEach(
      input.checkpointRefs,
      (checkpointRef) =>
        git.execute({
          operation,
          cwd: input.cwd,
          args: ["update-ref", "-d", checkpointRef],
          allowNonZeroExit: true,
        }),
      { discard: true },
    );
  });

  return {
    isGitRepository,
    captureCheckpoint,
    hasCheckpointRef,
    checkpointRefMatchesWorkspace,
    restoreCheckpoint: (input) => coordinator.withCheckout(input.cwd, restoreCheckpoint(input)),
    diffCheckpoints,
    diffCheckpointFiles,
    deleteCheckpointRefs,
  } satisfies CheckpointStoreShape;
});

export const CheckpointStoreLive = Layer.effect(CheckpointStore, makeCheckpointStore).pipe(
  Layer.provideMerge(CheckoutCoordinatorLive),
);
