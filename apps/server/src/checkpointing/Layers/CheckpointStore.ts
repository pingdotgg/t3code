/**
 * CheckpointStoreLive - Filesystem checkpoint store adapter layer.
 *
 * Implements VCS-native checkpoint capture/restore. Git repositories use
 * hidden refs and git object plumbing; jj repositories leverage the
 * operation log — each checkpoint records the current operation ID, and
 * restore/diff resolve the working-copy commit at that operation via
 * `--at-op`.
 *
 * This layer owns filesystem/VCS interactions only; it does not persist
 * checkpoint metadata and does not coordinate provider rollback semantics.
 *
 * @module CheckpointStoreLive
 */
import { randomUUID } from "node:crypto";

import { Effect, Layer, FileSystem, Path } from "effect";

import { CheckpointInvariantError } from "../Errors.ts";
import { GitCommandError } from "@t3tools/contracts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { CheckpointRef } from "@t3tools/contracts";
import { VcsCore } from "../../vcs/Services/VcsCore.ts";
import { detectRepoKind } from "../../vcs/Utils.ts";
import { resolveJjRepoDir, runJjCommand, runJjStdout } from "../../jj/Utils.ts";

const JJ_CHECKPOINTS_DIR = "t3-checkpoints";

interface JjCheckpointPayload {
  operationId?: unknown;
  /** @deprecated Legacy format — kept for backward compatibility. */
  commitId?: unknown;
}

function encodeCheckpointRef(checkpointRef: CheckpointRef): string {
  return Buffer.from(checkpointRef, "utf8").toString("hex");
}

const makeCheckpointStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsCore;
  const repoKindOf = (cwd: string) => detectRepoKind(cwd);

  // ---------------------------------------------------------------------------
  // JJ oplog helpers
  // ---------------------------------------------------------------------------

  /** Force a working-copy snapshot and return the current operation ID. */
  const readJjOperationId = (cwd: string): Effect.Effect<string | null, GitCommandError> =>
    // `jj file track .` forces a snapshot (including untracked files) and
    // produces an operation that captures the full working-copy state.
    trackJjWorkspace(cwd).pipe(
      Effect.flatMap(() =>
        runJjStdout("CheckpointStore.readJjOperationId", cwd, [
          "op",
          "log",
          "--limit",
          "1",
          "--no-graph",
          "-T",
          "self.id()",
        ]),
      ),
      Effect.map((stdout) => {
        const opId = stdout.trim();
        return opId.length > 0 ? opId : null;
      }),
      Effect.catch(() => Effect.succeed(null)),
    );

  /** Resolve the working-copy commit ID at a specific operation. */
  const readJjCommitIdAtOp = (
    cwd: string,
    operationId: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    runJjStdout("CheckpointStore.readJjCommitIdAtOp", cwd, [
      "log",
      "-r",
      "@",
      "--no-graph",
      "-T",
      'commit_id ++ "\\n"',
      "--at-op",
      operationId,
    ]).pipe(
      Effect.map((stdout) => {
        const commitId = stdout.trim();
        return commitId.length > 0 ? commitId : null;
      }),
      Effect.catch(() => Effect.succeed(null)),
    );

  /** Read current working-copy commit (fallback for legacy checkpoints). */
  const readJjCommitId = (cwd: string): Effect.Effect<string | null, GitCommandError> =>
    runJjStdout("CheckpointStore.readJjCommitId", cwd, [
      "log",
      "-r",
      "@",
      "--no-graph",
      "-T",
      'commit_id ++ "\\n"',
    ]).pipe(
      Effect.map((stdout) => {
        const commitId = stdout.trim();
        return commitId.length > 0 ? commitId : null;
      }),
      Effect.catch(() => Effect.succeed(null)),
    );

  const resolveJjCheckpointPath = (cwd: string, checkpointRef: CheckpointRef) =>
    resolveJjRepoDir(cwd).pipe(
      Effect.map((repoDir) =>
        path.join(repoDir, JJ_CHECKPOINTS_DIR, `${encodeCheckpointRef(checkpointRef)}.json`),
      ),
    );

  /**
   * Resolve the commit ID stored in a checkpoint file.
   * Supports both the new oplog format (`operationId`) and the legacy
   * format (`commitId`).
   */
  const resolveJjCheckpointCommit = (
    cwd: string,
    checkpointRef: CheckpointRef,
  ): Effect.Effect<string | null, GitCommandError> =>
    resolveJjCheckpointPath(cwd, checkpointRef).pipe(
      Effect.flatMap((checkpointPath) => fs.readFileString(checkpointPath)),
      Effect.map((raw) => JSON.parse(raw) as JjCheckpointPayload),
      Effect.flatMap((payload) => {
        // New format: resolve commit from the operation ID.
        if (typeof payload.operationId === "string" && payload.operationId.trim().length > 0) {
          return readJjCommitIdAtOp(cwd, payload.operationId.trim());
        }
        // Legacy format: commit ID stored directly.
        if (typeof payload.commitId === "string" && payload.commitId.trim().length > 0) {
          return Effect.succeed(payload.commitId.trim());
        }
        return Effect.succeed(null);
      }),
      Effect.catch(() => Effect.succeed(null)),
    );

  const trackJjWorkspace = (cwd: string) =>
    runJjCommand({
      operation: "CheckpointStore.trackJjWorkspace",
      cwd,
      args: ["file", "track", "."],
      allowNonZeroExit: true,
    }).pipe(
      Effect.flatMap((result) => {
        if (result.code === 0) {
          return Effect.void;
        }

        const detail = result.stderr.trim();
        return detail.length === 0 || detail.includes("No arguments")
          ? Effect.void
          : Effect.fail(
              new GitCommandError({
                operation: "CheckpointStore.trackJjWorkspace",
                command: "jj file track .",
                cwd,
                detail,
              }),
            );
      }),
    );

  const resolveHeadCommit = (cwd: string): Effect.Effect<string | null, GitCommandError> =>
    vcs
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
    vcs
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
    vcs
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

  const isGitRepository: CheckpointStoreShape["isGitRepository"] = (cwd) =>
    Effect.succeed(repoKindOf(cwd) !== null);

  const captureCheckpoint: CheckpointStoreShape["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    if (repoKindOf(input.cwd) === "jj") {
      // readJjOperationId tracks files and snapshots the working copy before
      // reading the operation ID, so the returned ID includes all current
      // file state — even when snapshot.auto-track is set to none().
      const operationId = yield* readJjOperationId(input.cwd);
      if (!operationId) {
        return yield* new GitCommandError({
          operation: "CheckpointStore.captureCheckpoint",
          command: "jj op log",
          cwd: input.cwd,
          detail: "Unable to resolve the current jj operation ID.",
        });
      }

      const checkpointPath = yield* resolveJjCheckpointPath(input.cwd, input.checkpointRef);
      yield* fs.makeDirectory(path.dirname(checkpointPath), { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new CheckpointInvariantError({
              operation: "CheckpointStore.captureCheckpoint",
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        ),
      );
      yield* fs.writeFileString(checkpointPath, JSON.stringify({ operationId }, null, 2)).pipe(
        Effect.mapError(
          (cause) =>
            new CheckpointInvariantError({
              operation: "CheckpointStore.captureCheckpoint",
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        ),
      );
      return;
    }

    const operation = "CheckpointStore.captureCheckpoint";

    yield* Effect.acquireUseRelease(
      fs.makeTempDirectory({ prefix: "t3-fs-checkpoint-" }),
      Effect.fn("captureCheckpoint.withTempDirectory")(function* (tempDir) {
        const tempIndexPath = path.join(tempDir, `index-${randomUUID()}`);
        const commitEnv: NodeJS.ProcessEnv = {
          ...process.env,
          GIT_INDEX_FILE: tempIndexPath,
          GIT_AUTHOR_NAME: "T3 Code",
          GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
          GIT_COMMITTER_NAME: "T3 Code",
          GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
        };

        const headExists = yield* hasHeadCommit(input.cwd);
        if (headExists) {
          yield* vcs.execute({
            operation,
            cwd: input.cwd,
            args: ["read-tree", "HEAD"],
            env: commitEnv,
          });
        }

        yield* vcs.execute({
          operation,
          cwd: input.cwd,
          args: ["add", "-A", "--", "."],
          env: commitEnv,
        });

        const writeTreeResult = yield* vcs.execute({
          operation,
          cwd: input.cwd,
          args: ["write-tree"],
          env: commitEnv,
        });
        const treeOid = writeTreeResult.stdout.trim();
        if (treeOid.length === 0) {
          return yield* new GitCommandError({
            operation,
            command: "git write-tree",
            cwd: input.cwd,
            detail: "git write-tree returned an empty tree oid.",
          });
        }

        const message = `t3 checkpoint ref=${input.checkpointRef}`;
        const commitTreeResult = yield* vcs.execute({
          operation,
          cwd: input.cwd,
          args: ["commit-tree", treeOid, "-m", message],
          env: commitEnv,
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

        yield* vcs.execute({
          operation,
          cwd: input.cwd,
          args: ["update-ref", input.checkpointRef, commitOid],
        });
      }),
      (tempDir) => fs.remove(tempDir, { recursive: true }),
    ).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          Effect.fail(
            new CheckpointInvariantError({
              operation: "CheckpointStore.captureCheckpoint",
              detail: "Failed to capture checkpoint.",
              cause: error,
            }),
          ),
      }),
    );
  });

  const hasCheckpointRef: CheckpointStoreShape["hasCheckpointRef"] = (input) =>
    (repoKindOf(input.cwd) === "jj"
      ? resolveJjCheckpointCommit(input.cwd, input.checkpointRef)
      : resolveCheckpointCommit(input.cwd, input.checkpointRef)
    ).pipe(Effect.map((commit) => commit !== null));

  const restoreCheckpoint: CheckpointStoreShape["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    if (repoKindOf(input.cwd) === "jj") {
      let commitOid = yield* resolveJjCheckpointCommit(input.cwd, input.checkpointRef);

      if (!commitOid && input.fallbackToHead === true) {
        commitOid = yield* readJjCommitId(input.cwd);
      }

      if (!commitOid) {
        return false;
      }

      yield* trackJjWorkspace(input.cwd);
      yield* runJjCommand({
        operation: "CheckpointStore.restoreCheckpoint",
        cwd: input.cwd,
        args: ["restore", "--from", commitOid],
      });
      return true;
    }

    const operation = "CheckpointStore.restoreCheckpoint";

    let commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);

    if (!commitOid && input.fallbackToHead === true) {
      commitOid = yield* resolveHeadCommit(input.cwd);
    }

    if (!commitOid) {
      return false;
    }

    yield* vcs.execute({
      operation,
      cwd: input.cwd,
      args: ["restore", "--source", commitOid, "--worktree", "--staged", "--", "."],
    });
    yield* vcs.execute({
      operation,
      cwd: input.cwd,
      args: ["clean", "-fd", "--", "."],
    });

    const headExists = yield* hasHeadCommit(input.cwd);
    if (headExists) {
      yield* vcs.execute({
        operation,
        cwd: input.cwd,
        args: ["reset", "--quiet", "--", "."],
      });
    }

    return true;
  });

  const diffCheckpoints: CheckpointStoreShape["diffCheckpoints"] = Effect.fn("diffCheckpoints")(
    function* (input) {
      if (repoKindOf(input.cwd) === "jj") {
        let fromCommitOid = yield* resolveJjCheckpointCommit(input.cwd, input.fromCheckpointRef);
        const toCommitOid = yield* resolveJjCheckpointCommit(input.cwd, input.toCheckpointRef);

        if (!fromCommitOid && input.fallbackFromToHead === true) {
          const headCommit = yield* readJjCommitId(input.cwd);
          if (headCommit) {
            fromCommitOid = headCommit;
          }
        }

        if (!fromCommitOid || !toCommitOid) {
          return yield* new GitCommandError({
            operation: "CheckpointStore.diffCheckpoints",
            command: "jj diff",
            cwd: input.cwd,
            detail: "Checkpoint ref is unavailable for diff operation.",
          });
        }

        const result = yield* runJjCommand({
          operation: "CheckpointStore.diffCheckpoints",
          cwd: input.cwd,
          args: ["diff", "--from", fromCommitOid, "--to", toCommitOid, "--git"],
        });
        return result.stdout;
      }

      const operation = "CheckpointStore.diffCheckpoints";

      let fromCommitOid = yield* resolveCheckpointCommit(input.cwd, input.fromCheckpointRef);
      const toCommitOid = yield* resolveCheckpointCommit(input.cwd, input.toCheckpointRef);

      if (!fromCommitOid && input.fallbackFromToHead === true) {
        const headCommit = yield* resolveHeadCommit(input.cwd);
        if (headCommit) {
          fromCommitOid = headCommit;
        }
      }

      if (!fromCommitOid || !toCommitOid) {
        return yield* new GitCommandError({
          operation,
          command: "git diff",
          cwd: input.cwd,
          detail: "Checkpoint ref is unavailable for diff operation.",
        });
      }

      const result = yield* vcs.execute({
        operation,
        cwd: input.cwd,
        args: ["diff", "--patch", "--minimal", "--no-color", fromCommitOid, toCommitOid],
      });

      return result.stdout;
    },
  );

  const deleteCheckpointRefs: CheckpointStoreShape["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    if (repoKindOf(input.cwd) === "jj") {
      yield* Effect.forEach(
        input.checkpointRefs,
        (checkpointRef) =>
          resolveJjCheckpointPath(input.cwd, checkpointRef).pipe(
            Effect.flatMap((checkpointPath) => fs.remove(checkpointPath)),
            Effect.catch(() => Effect.void),
          ),
        { discard: true },
      );
      return;
    }

    const operation = "CheckpointStore.deleteCheckpointRefs";

    yield* Effect.forEach(
      input.checkpointRefs,
      (checkpointRef) =>
        vcs.execute({
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
    restoreCheckpoint,
    diffCheckpoints,
    deleteCheckpointRefs,
  } satisfies CheckpointStoreShape;
});

export const CheckpointStoreLive = Layer.effect(CheckpointStore, makeCheckpointStore);
