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
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  CheckpointGitCommandError,
  CheckpointRepositoryError,
  CheckpointUnavailableError,
  type CheckpointStoreError,
} from "../Errors.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { runGit, RunGitInput } from "../../git/Process.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";

function causeDetail(cause: unknown, fallback: string): string {
  if (cause instanceof GitCommandError) {
    return cause.detail;
  }
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function mapFilesystemFailure(
  operation: string,
  cwd: string,
  cause: unknown,
): CheckpointStoreError {
  const detail = causeDetail(cause, `${operation} failed.`);

  const unavailable =
    /^Filesystem checkpoint is unavailable for turn (\d+) in thread (.+)\.?$/i.exec(detail);
  if (unavailable) {
    const [, rawTurnCount, threadId] = unavailable;
    const turnCount = Number.parseInt(rawTurnCount ?? "", 10);
    if (threadId && Number.isInteger(turnCount) && turnCount >= 0) {
      return new CheckpointUnavailableError({
        threadId,
        turnCount,
        detail,
        cause,
      });
    }
  }

  const lowered = detail.toLowerCase();
  if (lowered.includes("not a git repository")) {
    return new CheckpointRepositoryError({
      cwd,
      detail,
      cause,
    });
  }

  return new CheckpointGitCommandError({
    operation,
    command: cause instanceof GitCommandError ? cause.command : "git",
    cwd,
    detail,
    cause,
  });
}

function resolveHeadCommit(
  cwd: string,
): Effect.Effect<string | null, GitCommandError, ChildProcessSpawner.ChildProcessSpawner> {
  return runGit({
    operation: "CheckpointStore.resolveHeadCommit",
    cwd,
    args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    allowNonZeroExit: true,
  }).pipe(
    Effect.map((result) => {
      if (result.code !== 0) {
        return null;
      }
      const commit = result.stdout.trim();
      return commit.length > 0 ? commit : null;
    }),
  );
}

function hasHeadCommit(
  cwd: string,
): Effect.Effect<boolean, GitCommandError, ChildProcessSpawner.ChildProcessSpawner> {
  return runGit({
    operation: "CheckpointStore.hasHeadCommit",
    cwd,
    args: ["rev-parse", "--verify", "HEAD"],
    allowNonZeroExit: true,
  }).pipe(Effect.map((result) => result.code === 0));
}

function resolveCheckpointCommit(
  cwd: string,
  checkpointRef: string,
): Effect.Effect<string | null, GitCommandError, ChildProcessSpawner.ChildProcessSpawner> {
  return runGit({
    operation: "CheckpointStore.resolveCheckpointCommit",
    cwd,
    args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
    allowNonZeroExit: true,
  }).pipe(
    Effect.map((result) => {
      if (result.code !== 0) {
        return null;
      }
      const commit = result.stdout.trim();
      return commit.length > 0 ? commit : null;
    }),
  );
}

function removeDirectory(pathname: string): Effect.Effect<void, never> {
  return Effect.tryPromise({
    try: () => rm(pathname, { recursive: true, force: true }),
    catch: (cause) => cause,
  }).pipe(Effect.orDie);
}

const makeCheckpointStore = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runGitWithSpawner = (input: RunGitInput) =>
    runGit(input).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  const resolveHeadCommitWithSpawner = (cwd: string) =>
    resolveHeadCommit(cwd).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  const hasHeadCommitWithSpawner = (cwd: string) =>
    hasHeadCommit(cwd).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  const resolveCheckpointCommitWithSpawner = (cwd: string, checkpointRef: string) =>
    resolveCheckpointCommit(cwd, checkpointRef).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

  const isGitRepository: CheckpointStoreShape["isGitRepository"] = (cwd) =>
    Effect.gen(function* () {
      const normalizedCwd = cwd.trim();

      return yield* runGitWithSpawner({
        operation: "CheckpointStore.isGitRepository",
        cwd: normalizedCwd,
        args: ["rev-parse", "--is-inside-work-tree"],
        allowNonZeroExit: true,
      }).pipe(
        Effect.map((result) => result.code === 0 && result.stdout.trim() === "true"),
        Effect.catch(() => Effect.succeed(false)),
      );
    });

  const captureCheckpoint: CheckpointStoreShape["captureCheckpoint"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.captureCheckpoint";
      const normalizedCwd = input.cwd.trim();
      const checkpointRef = input.checkpointRef.trim();

      yield* Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => mkdtemp(path.join(os.tmpdir(), "t3-fs-checkpoint-")),
          catch: (cause) => cause,
        }),
        (tempDir) =>
          Effect.gen(function* () {
            const tempIndexPath = path.join(tempDir, `index-${randomUUID()}`);
            const commitEnv: NodeJS.ProcessEnv = {
              ...process.env,
              GIT_INDEX_FILE: tempIndexPath,
              GIT_AUTHOR_NAME: "T3 Code",
              GIT_AUTHOR_EMAIL: "codex@users.noreply.github.com",
              GIT_COMMITTER_NAME: "T3 Code",
              GIT_COMMITTER_EMAIL: "codex@users.noreply.github.com",
            };

            const headExists = yield* hasHeadCommitWithSpawner(normalizedCwd);
            if (headExists) {
              yield* runGitWithSpawner({
                operation,
                cwd: normalizedCwd,
                args: ["read-tree", "HEAD"],
                env: commitEnv,
              });
            }

            yield* runGitWithSpawner({
              operation,
              cwd: normalizedCwd,
              args: ["add", "-A", "--", "."],
              env: commitEnv,
            });

            const writeTreeResult = yield* runGitWithSpawner({
              operation,
              cwd: normalizedCwd,
              args: ["write-tree"],
              env: commitEnv,
            });
            const treeOid = writeTreeResult.stdout.trim();
            if (treeOid.length === 0) {
              return yield* Effect.fail(
                new CheckpointGitCommandError({
                  operation,
                  command: "git write-tree",
                  cwd: normalizedCwd,
                  detail: "git write-tree returned an empty tree oid.",
                }),
              );
            }

            const message = `t3 checkpoint ref=${checkpointRef}`;
            const commitTreeResult = yield* runGitWithSpawner({
              operation,
              cwd: normalizedCwd,
              args: ["commit-tree", treeOid, "-m", message],
              env: commitEnv,
            });
            const commitOid = commitTreeResult.stdout.trim();
            if (commitOid.length === 0) {
              return yield* Effect.fail(
                new CheckpointGitCommandError({
                  operation,
                  command: "git commit-tree",
                  cwd: normalizedCwd,
                  detail: "git commit-tree returned an empty commit oid.",
                }),
              );
            }

            yield* runGitWithSpawner({
              operation,
              cwd: normalizedCwd,
              args: ["update-ref", checkpointRef, commitOid],
            });
          }),
        removeDirectory,
      ).pipe(Effect.mapError((cause) => mapFilesystemFailure(operation, normalizedCwd, cause)));
    });

  const hasCheckpointRef: CheckpointStoreShape["hasCheckpointRef"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.hasCheckpointRef";
      const normalizedCwd = input.cwd.trim();
      const checkpointRef = input.checkpointRef.trim();

      return yield* resolveCheckpointCommitWithSpawner(normalizedCwd, checkpointRef).pipe(
        Effect.map((commit) => commit !== null),
        Effect.mapError((cause) => mapFilesystemFailure(operation, normalizedCwd, cause)),
      );
    });

  const ensureRootCheckpoint: CheckpointStoreShape["ensureRootCheckpoint"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.ensureRootCheckpoint";
      const normalizedCwd = input.cwd.trim();
      const checkpointRef = input.checkpointRef.trim();

      const existing = yield* resolveCheckpointCommitWithSpawner(normalizedCwd, checkpointRef).pipe(
        Effect.mapError((cause) => mapFilesystemFailure(operation, normalizedCwd, cause)),
      );
      if (existing) {
        return true;
      }

      const headCommit = yield* resolveHeadCommitWithSpawner(normalizedCwd).pipe(
        Effect.mapError((cause) => mapFilesystemFailure(operation, normalizedCwd, cause)),
      );
      if (!headCommit) {
        return false;
      }

      yield* runGitWithSpawner({
        operation,
        cwd: normalizedCwd,
        args: ["update-ref", checkpointRef, headCommit],
      }).pipe(Effect.mapError((cause) => mapFilesystemFailure(operation, normalizedCwd, cause)));
      return true;
    });

  const restoreCheckpoint: CheckpointStoreShape["restoreCheckpoint"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.restoreCheckpoint";
      const normalizedCwd = input.cwd.trim();
      const checkpointRef = input.checkpointRef.trim();

      let commitOid = yield* resolveCheckpointCommitWithSpawner(normalizedCwd, checkpointRef).pipe(
        Effect.mapError((cause) => mapFilesystemFailure(operation, normalizedCwd, cause)),
      );

      if (!commitOid && input.fallbackToHead === true) {
        commitOid = yield* resolveHeadCommitWithSpawner(normalizedCwd).pipe(
          Effect.mapError((cause) => mapFilesystemFailure(operation, normalizedCwd, cause)),
        );
      }

      if (!commitOid) {
        return false;
      }

      yield* runGitWithSpawner({
        operation,
        cwd: normalizedCwd,
        args: ["restore", "--source", commitOid, "--worktree", "--staged", "--", "."],
      }).pipe(Effect.mapError((cause) => mapFilesystemFailure(operation, normalizedCwd, cause)));
      yield* runGitWithSpawner({
        operation,
        cwd: normalizedCwd,
        args: ["clean", "-fd", "--", "."],
      }).pipe(Effect.mapError((cause) => mapFilesystemFailure(operation, normalizedCwd, cause)));

      const headExists = yield* hasHeadCommitWithSpawner(normalizedCwd).pipe(
        Effect.mapError((cause) => mapFilesystemFailure(operation, normalizedCwd, cause)),
      );
      if (headExists) {
        yield* runGitWithSpawner({
          operation,
          cwd: normalizedCwd,
          args: ["reset", "--quiet", "--", "."],
        }).pipe(Effect.mapError((cause) => mapFilesystemFailure(operation, normalizedCwd, cause)));
      }

      return true;
    });

  const diffCheckpoints: CheckpointStoreShape["diffCheckpoints"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.diffCheckpoints";
      const normalizedCwd = input.cwd.trim();
      const fromCheckpointRef = input.fromCheckpointRef.trim();
      const toCheckpointRef = input.toCheckpointRef.trim();

      let fromCommitOid = yield* resolveCheckpointCommitWithSpawner(
        normalizedCwd,
        fromCheckpointRef,
      ).pipe(Effect.mapError((cause) => mapFilesystemFailure(operation, normalizedCwd, cause)));
      const toCommitOid = yield* resolveCheckpointCommitWithSpawner(
        normalizedCwd,
        toCheckpointRef,
      ).pipe(Effect.mapError((cause) => mapFilesystemFailure(operation, normalizedCwd, cause)));

      if (!fromCommitOid && input.fallbackFromToHead === true) {
        const headCommit = yield* resolveHeadCommitWithSpawner(normalizedCwd).pipe(
          Effect.mapError((cause) => mapFilesystemFailure(operation, normalizedCwd, cause)),
        );
        if (headCommit) {
          fromCommitOid = headCommit;
        }
      }

      if (!fromCommitOid || !toCommitOid) {
        return yield* Effect.fail(
          new CheckpointGitCommandError({
            operation,
            command: "git diff",
            cwd: normalizedCwd,
            detail: "Checkpoint ref is unavailable for diff operation.",
          }),
        );
      }

      const result = yield* runGitWithSpawner({
        operation,
        cwd: normalizedCwd,
        args: ["diff", "--patch", "--minimal", "--no-color", fromCommitOid, toCommitOid],
      }).pipe(Effect.mapError((cause) => mapFilesystemFailure(operation, normalizedCwd, cause)));

      return result.stdout;
    });

  const deleteCheckpointRefs: CheckpointStoreShape["deleteCheckpointRefs"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.deleteCheckpointRefs";
      const normalizedCwd = input.cwd.trim();
      const checkpointRefs = input.checkpointRefs.map((ref) => ref.trim());

      yield* Effect.forEach(
        checkpointRefs,
        (checkpointRef) =>
          runGitWithSpawner({
            operation,
            cwd: normalizedCwd,
            args: ["update-ref", "-d", checkpointRef],
            allowNonZeroExit: true,
          }).pipe(
            Effect.mapError((cause) => mapFilesystemFailure(operation, normalizedCwd, cause)),
          ),
        { discard: true },
      );
    });

  return {
    isGitRepository,
    captureCheckpoint,
    hasCheckpointRef,
    ensureRootCheckpoint,
    restoreCheckpoint,
    diffCheckpoints,
    deleteCheckpointRefs,
  } satisfies CheckpointStoreShape;
});

export const CheckpointStoreLive = Layer.effect(CheckpointStore, makeCheckpointStore);
