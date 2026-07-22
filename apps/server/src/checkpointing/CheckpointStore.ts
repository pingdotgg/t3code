/**
 * CheckpointStore - Repository interface for filesystem-backed workspace checkpoints.
 *
 * Owns hidden checkpoint capture/restore and diff computation for a workspace
 * thread timeline. Git workspaces use their repository's hidden refs; other
 * workspaces use a T3-managed shadow Git store outside the project directory.
 *
 * The live adapter resolves the active VCS driver once per checkpoint operation
 * and delegates to the driver's optional checkpoint capability.
 *
 * Uses Effect `Context.Service` for dependency injection and exposes typed
 * domain errors for checkpoint storage operations.
 *
 * @module CheckpointStore
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import { type CheckpointRef, VcsProcessExitError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import type { CheckpointStoreError } from "./Errors.ts";
import type { VcsCheckpointOps } from "../vcs/VcsDriver.ts";
import { ServerConfig } from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

/** Service tag for checkpoint persistence and restore operations. */
export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    /** Check whether cwd is inside a user-managed Git worktree. */
    readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Capture a checkpoint commit and store it at the provided checkpoint ref.
     *
     * Uses an isolated temporary Git index and writes a hidden ref.
     */
    readonly captureCheckpoint: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<void, CheckpointStoreError>;

    /** Check whether a checkpoint ref exists. */
    readonly hasCheckpointRef: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Restore workspace and staging state to a checkpoint.
     *
     * Optionally falls back to current `HEAD` when the checkpoint ref is missing.
     */
    readonly restoreCheckpoint: (
      input: RestoreCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Compute a patch diff between two checkpoint refs.
     *
     * Can optionally treat a missing "from" ref as `HEAD`.
     */
    readonly diffCheckpoints: (
      input: DiffCheckpointsInput,
    ) => Effect.Effect<string, CheckpointStoreError>;

    /**
     * Delete the provided checkpoint refs.
     *
     * Best-effort delete: missing refs are tolerated.
     */
    readonly deleteCheckpointRefs: (
      input: DeleteCheckpointRefsInput,
    ) => Effect.Effect<void, CheckpointStoreError>;
  }
>()("t3/checkpointing/CheckpointStore") {}

export const make = Effect.gen(function* () {
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;

  const shadowRepositoryPath = (cwd: string) =>
    NodePath.join(
      config.stateDir,
      "checkpoints",
      NodeCrypto.createHash("sha256").update(NodePath.resolve(cwd)).digest("hex"),
    );
  const canonicalizeWorkspacePath = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => NodePath.resolve(value)));

  const runShadowGit = Effect.fn("CheckpointStore.runShadowGit")(function* (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly env?: NodeJS.ProcessEnv;
    readonly allowNonZeroExit?: boolean;
    readonly maxOutputBytes?: number;
  }) {
    const gitDir = shadowRepositoryPath(input.cwd);
    yield* vcsProcess.run({
      operation: `${input.operation}.init`,
      command: "git",
      cwd: input.cwd,
      args: ["init", "--bare", "--quiet", gitDir],
    });
    return yield* vcsProcess.run({
      operation: input.operation,
      command: "git",
      cwd: input.cwd,
      args: [`--git-dir=${gitDir}`, `--work-tree=${NodePath.resolve(input.cwd)}`, ...input.args],
      ...(input.env ? { env: input.env } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
    });
  });

  const resolveShadowCommit = Effect.fn("CheckpointStore.resolveShadowCommit")(function* (input: {
    readonly cwd: string;
    readonly checkpointRef: CheckpointRef;
  }) {
    const refResult = yield* runShadowGit({
      operation: "CheckpointStore.shadow.resolveCheckpointRef",
      cwd: input.cwd,
      args: ["for-each-ref", "--format=%(objectname)", "--", input.checkpointRef],
      allowNonZeroExit: true,
    });
    const refStdout = refResult.stdout.trim();
    const refStderr = refResult.stderr.trim();
    if (refResult.exitCode !== 0 || (refStdout.length === 0 && refStderr.length > 0)) {
      return yield* new VcsProcessExitError({
        operation: "CheckpointStore.shadow.resolveCheckpointRef",
        command: "git for-each-ref",
        cwd: input.cwd,
        exitCode: refResult.exitCode === 0 ? 1 : refResult.exitCode,
        detail: "Failed to resolve shadow checkpoint ref.",
        stderrLength: refStderr.length,
        stderrTruncated: refResult.stderrTruncated,
      });
    }
    if (refStdout.length === 0) {
      return null;
    }

    const result = yield* runShadowGit({
      operation: "CheckpointStore.shadow.resolveCheckpointCommit",
      cwd: input.cwd,
      args: ["rev-parse", "--verify", "--quiet", `${input.checkpointRef}^{commit}`],
      allowNonZeroExit: true,
    });
    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();
    if (result.exitCode !== 0) {
      return yield* new VcsProcessExitError({
        operation: "CheckpointStore.shadow.resolveCheckpointCommit",
        command: "git rev-parse",
        cwd: input.cwd,
        exitCode: result.exitCode,
        detail: `Checkpoint ref ${input.checkpointRef} does not resolve to a commit.`,
        stderrLength: stderr.length,
        stderrTruncated: result.stderrTruncated,
      });
    }
    return stdout.length > 0 ? stdout : null;
  });

  const shadowCheckpoints: VcsCheckpointOps = {
    captureCheckpoint: Effect.fn("CheckpointStore.shadow.captureCheckpoint")(function* (input) {
      const gitDir = shadowRepositoryPath(input.cwd);
      const tempIndexPath = NodePath.join(gitDir, `t3-checkpoint-index-${NodeCrypto.randomUUID()}`);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_INDEX_FILE: tempIndexPath,
        GIT_AUTHOR_NAME: "T3 Code",
        GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
        GIT_COMMITTER_NAME: "T3 Code",
        GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
      };
      const cleanup = fileSystem.remove(tempIndexPath, { force: true }).pipe(Effect.ignore);

      yield* Effect.gen(function* () {
        yield* runShadowGit({
          operation: "CheckpointStore.shadow.captureCheckpoint.readTree",
          cwd: input.cwd,
          args: ["read-tree", "--empty"],
          env,
        });
        yield* runShadowGit({
          operation: "CheckpointStore.shadow.captureCheckpoint.add",
          cwd: input.cwd,
          args: ["add", "-A", "--", "."],
          env,
        });
        const tree = yield* runShadowGit({
          operation: "CheckpointStore.shadow.captureCheckpoint.writeTree",
          cwd: input.cwd,
          args: ["write-tree"],
          env,
        });
        const commit = yield* runShadowGit({
          operation: "CheckpointStore.shadow.captureCheckpoint.commitTree",
          cwd: input.cwd,
          args: [
            "commit-tree",
            tree.stdout.trim(),
            "-m",
            `t3 checkpoint ref=${input.checkpointRef}`,
          ],
          env,
        });
        yield* runShadowGit({
          operation: "CheckpointStore.shadow.captureCheckpoint.updateRef",
          cwd: input.cwd,
          args: ["update-ref", input.checkpointRef, commit.stdout.trim()],
        });
      }).pipe(Effect.ensuring(cleanup));
    }),

    hasCheckpointRef: (input) =>
      resolveShadowCommit(input).pipe(Effect.map((commit) => commit !== null)),

    restoreCheckpoint: Effect.fn("CheckpointStore.shadow.restoreCheckpoint")(function* (input) {
      const commit = yield* resolveShadowCommit(input);
      if (!commit) {
        // Shadow repositories intentionally have no HEAD: every restorable
        // state must be addressed by its explicit checkpoint ref. Fail closed
        // so callers never roll conversation history back without matching files.
        return false;
      }
      const tempIndexPath = NodePath.join(
        shadowRepositoryPath(input.cwd),
        `t3-checkpoint-index-${NodeCrypto.randomUUID()}`,
      );
      const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: tempIndexPath };
      const cleanup = fileSystem.remove(tempIndexPath, { force: true }).pipe(Effect.ignore);
      yield* Effect.gen(function* () {
        yield* runShadowGit({
          operation: "CheckpointStore.shadow.restoreCheckpoint.readTree",
          cwd: input.cwd,
          args: ["read-tree", commit],
          env,
        });
        yield* runShadowGit({
          operation: "CheckpointStore.shadow.restoreCheckpoint.checkout",
          cwd: input.cwd,
          args: ["checkout-index", "--all", "--force"],
          env,
        });
        yield* runShadowGit({
          operation: "CheckpointStore.shadow.restoreCheckpoint.clean",
          cwd: input.cwd,
          args: ["clean", "-fd", "--", "."],
          env,
        });
      }).pipe(Effect.ensuring(cleanup));
      return true;
    }),

    diffCheckpoints: Effect.fn("CheckpointStore.shadow.diffCheckpoints")(function* (input) {
      const result = yield* runShadowGit({
        operation: "CheckpointStore.shadow.diffCheckpoints",
        cwd: input.cwd,
        args: [
          "diff",
          "--patch",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          `${input.fromCheckpointRef}^{commit}`,
          `${input.toCheckpointRef}^{commit}`,
        ],
        allowNonZeroExit: true,
        maxOutputBytes: 50 * 1024 * 1024,
      });
      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation: "CheckpointStore.shadow.diffCheckpoints",
          command: "git diff",
          cwd: input.cwd,
          exitCode: result.exitCode,
          detail: "Checkpoint ref is unavailable for diff operation.",
          stderrLength: result.stderr.trim().length,
          stderrTruncated: result.stderrTruncated,
        });
      }
      return result.stdout;
    }),

    deleteCheckpointRefs: Effect.fn("CheckpointStore.shadow.deleteCheckpointRefs")(
      function* (input) {
        yield* Effect.forEach(
          input.checkpointRefs,
          (checkpointRef) =>
            runShadowGit({
              operation: "CheckpointStore.shadow.deleteCheckpointRefs",
              cwd: input.cwd,
              args: ["update-ref", "-d", checkpointRef],
              allowNonZeroExit: true,
            }),
          { concurrency: 1, discard: true },
        );
      },
    ),
  };

  const resolveCheckpoints = Effect.fn("CheckpointStore.resolveCheckpoints")(function* (
    _operation: string,
    cwd: string,
  ) {
    const handle = yield* vcsRegistry.detect({ cwd });
    const workspaceOwnsRepository =
      handle !== null &&
      (yield* canonicalizeWorkspacePath(handle.repository.rootPath)) ===
        (yield* canonicalizeWorkspacePath(cwd));
    return workspaceOwnsRepository
      ? (handle.driver.checkpoints ?? shadowCheckpoints)
      : shadowCheckpoints;
  });

  const isGitRepository: CheckpointStore["Service"]["isGitRepository"] = Effect.fn(
    "CheckpointStore.isGitRepository",
  )(function* (cwd) {
    const repository = yield* vcsRegistry.detect({ cwd, requestedKind: "git" });
    return (
      repository !== null &&
      (yield* canonicalizeWorkspacePath(repository.repository.rootPath)) ===
        (yield* canonicalizeWorkspacePath(cwd))
    );
  });

  const captureCheckpoint: CheckpointStore["Service"]["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.captureCheckpoint", input.cwd);
    return yield* checkpoints.captureCheckpoint(input);
  });

  const hasCheckpointRef: CheckpointStore["Service"]["hasCheckpointRef"] = Effect.fn(
    "hasCheckpointRef",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.hasCheckpointRef", input.cwd);
    return yield* checkpoints.hasCheckpointRef(input);
  });

  const restoreCheckpoint: CheckpointStore["Service"]["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.restoreCheckpoint", input.cwd);
    return yield* checkpoints.restoreCheckpoint(input);
  });

  const diffCheckpoints: CheckpointStore["Service"]["diffCheckpoints"] = Effect.fn(
    "diffCheckpoints",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.diffCheckpoints", input.cwd);
    return yield* checkpoints.diffCheckpoints(input);
  });

  const deleteCheckpointRefs: CheckpointStore["Service"]["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(
      "CheckpointStore.deleteCheckpointRefs",
      input.cwd,
    );
    return yield* checkpoints.deleteCheckpointRefs(input);
  });

  return CheckpointStore.of({
    isGitRepository,
    captureCheckpoint,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    deleteCheckpointRefs,
  });
});

export const layer = Layer.effect(CheckpointStore, make);
