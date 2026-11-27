// @effect-diagnostics nodeBuiltinImport:off - temporary restore bookmark names must not collide.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import {
  type VcsError,
  VcsProcessExitError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import { PATCH_RENDER_PREFIX_ARGS } from "./GitVcsDriverCore.ts";
import { colocatedGitCommand, jjCommand } from "./JjProcess.ts";
import type { JjChange } from "./JjVcsDriver.ts";
import type * as VcsDriver from "./VcsDriver.ts";
import type * as VcsProcess from "./VcsProcess.ts";
import { inspectWorkspaceFiles } from "./WorkspaceFileSafety.ts";
import { GitCommandError } from "@t3tools/contracts";

export interface JjCheckpointDeps {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly process: VcsProcess.VcsProcess["Service"];
  /** Fails unless jj can operate here; yields the colocated git store. */
  readonly ensureGitDir: (operation: string, cwd: string) => Effect.Effect<string, VcsError>;
  readonly currentChange: (cwd: string) => Effect.Effect<JjChange, VcsError>;
}

// Hide jj's synthetic conflict trees; the conflicted path still contains one arbitrary side.
// No `glob` magic: `*` must match `/` to exclude the files below those trees too.
export const JJ_CONFLICT_PATHSPECS = [
  "--",
  ".",
  ":(exclude).jjconflict-*",
  ":(exclude)JJ-CONFLICT-README",
] as const;

/** git's empty tree. The diff base when `@` has no real parent. */
export const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;
const CHECKPOINT_REF_UNAVAILABLE_DETAIL = "Checkpoint ref is unavailable for diff operation.";
const MISSING_REVISION_PATTERN = /Revision .* doesn't exist/i;
const durableWrite = ["-c", "core.fsync=objects,reference", "-c", "core.fsyncMethod=fsync"];

export const makeJjCheckpointOps = (deps: JjCheckpointDeps): VcsDriver.VcsCheckpointOps => {
  const resolveRefCommit = (gitDir: string, cwd: string, checkpointRef: string) =>
    colocatedGitCommand(
      deps.process,
      "JjVcsDriver.checkpoints.resolveCheckpointCommit",
      { gitDir, cwd },
      ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        const commitId = result.stdout.trim();
        return commitId.length > 0 ? commitId : null;
      }),
    );

  const restoreFrom = (operation: string, cwd: string, commitId: string) =>
    jjCommand(deps.process, operation, cwd, ["restore", "--from", commitId], {
      allowNonZeroExit: true,
    });

  /**
   * Only reachable once `jj op abandon` or `jj util gc` dropped the commit from jj's index; the
   * object itself survives in git because the checkpoint ref pins it.
   */
  const restoreThroughGitObject = Effect.fn("JjVcsDriver.checkpoints.restoreThroughGitObject")(
    function* (
      operation: string,
      gitDir: string,
      cwd: string,
      commitId: string,
    ): Effect.fn.Return<void, VcsError> {
      const tempBookmark = `t3-restore-${NodeCrypto.randomUUID()}`;
      const tempRef = `refs/heads/${tempBookmark}`;

      yield* Effect.gen(function* () {
        yield* colocatedGitCommand(deps.process, operation, { gitDir, cwd }, [
          "update-ref",
          tempRef,
          commitId,
        ]);
        yield* jjCommand(deps.process, operation, cwd, ["git", "import"]);

        const retried = yield* restoreFrom(operation, cwd, commitId);
        if (retried.exitCode !== 0) {
          return yield* new VcsProcessExitError({
            operation,
            command: "jj restore",
            cwd,
            exitCode: retried.exitCode,
            detail: retried.stderr.trim() || "jj restore failed.",
          });
        }
      }).pipe(
        Effect.ensuring(
          Effect.all(
            [
              jjCommand(deps.process, operation, cwd, ["bookmark", "forget", tempBookmark], {
                allowNonZeroExit: true,
              }),
              colocatedGitCommand(
                deps.process,
                operation,
                { gitDir, cwd },
                ["update-ref", "-d", tempRef],
                { allowNonZeroExit: true },
              ),
            ],
            { discard: true },
          ).pipe(Effect.ignore),
        ),
      );
    },
  );

  return {
    // Git HEAD does not describe jj's working-copy change; always take the native snapshot.
    resolveCleanHead: () => Effect.succeed(null),
    captureHeadCheckpoint: () =>
      Effect.fail(
        new VcsUnsupportedOperationError({
          operation: "JjVcsDriver.checkpoints.captureHeadCheckpoint",
          kind: "jj",
          detail: "Jujutsu checkpoints must capture the working-copy change.",
        }),
      ),
    // jj refs name native snapshots, not Git's extra checkpoint commits with capture-time HEAD.
    listAuthoredPaths: () => Effect.succeed(null),
    captureCheckpoint: Effect.fn("JjVcsDriver.checkpoints.captureCheckpoint")(function* (input) {
      const operation = "JjVcsDriver.checkpoints.captureCheckpoint";
      const gitDir = yield* deps.ensureGitDir(operation, input.cwd);

      // Reading `@` without `--ignore-working-copy` is the snapshot: jj writes a new commit id
      // under the same change id, moving neither `@` nor any bookmark.
      const change = yield* deps.currentChange(input.cwd);
      if (change.conflict) {
        yield* Effect.logWarning("jj checkpoint captured a conflicted working copy", {
          cwd: input.cwd,
          checkpointRef: input.checkpointRef,
        });
      }

      yield* colocatedGitCommand(deps.process, operation, { gitDir, cwd: input.cwd }, [
        ...durableWrite,
        "update-ref",
        input.checkpointRef,
        change.commitId,
      ]);
      const inspection = yield* inspectWorkspaceFiles({
        includeIgnored: false,
        cwd: input.cwd,
        repositoryCwd: input.cwd,
        revision: change.commitId,
        fileSystem: deps.fileSystem,
        path: deps.path,
        execute: (request) =>
          colocatedGitCommand(
            deps.process,
            request.operation,
            { gitDir, cwd: request.cwd },
            request.args,
            {
              ...(request.env ? { env: request.env } : {}),
              ...(request.maxOutputBytes !== undefined
                ? { maxOutputBytes: request.maxOutputBytes }
                : {}),
            },
          ).pipe(
            Effect.mapError(
              (cause) =>
                new GitCommandError({
                  operation: request.operation,
                  command: "git",
                  cwd: request.cwd,
                  detail: "Could not inspect checkpoint exclusions.",
                  cause,
                }),
            ),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new VcsProcessExitError({
              operation,
              command: "git ls-files",
              cwd: input.cwd,
              exitCode: 1,
              detail: `Checkpoint was captured but its exclusions could not be inspected: ${cause.message}`,
            }),
        ),
      );
      return {
        exclusions: [
          ...(inspection.exclusions.length > 0
            ? [
                `Files outside this checkpoint: ${inspection.exclusions.slice(0, 50).join(", ")}${inspection.exclusions.length > 50 ? " (more omitted)" : ""}`,
              ]
            : []),
          ...(inspection.truncated
            ? [
                "Checkpoint exclusion listing was truncated; additional files may be outside this checkpoint.",
              ]
            : []),
        ],
      };
    }),

    hasCheckpointRef: Effect.fn("JjVcsDriver.checkpoints.hasCheckpointRef")(function* (input) {
      const gitDir = yield* deps.ensureGitDir(
        "JjVcsDriver.checkpoints.hasCheckpointRef",
        input.cwd,
      );
      return (yield* resolveRefCommit(gitDir, input.cwd, input.checkpointRef)) !== null;
    }),

    copyCheckpointRef: Effect.fn("JjVcsDriver.checkpoints.copyCheckpointRef")(function* (input) {
      const operation = "JjVcsDriver.checkpoints.copyCheckpointRef";
      const { cwd, fromCheckpointRef, toCheckpointRef } = input;
      const gitDir = yield* deps.ensureGitDir(operation, cwd);
      const commit = yield* resolveRefCommit(gitDir, cwd, fromCheckpointRef);
      if (commit === null) return false;
      // Secondary jj workspaces share the Git store, but not a worktree index for its submodules.
      const hasSubmodules = yield* deps.fileSystem
        .exists(deps.path.join(cwd, ".gitmodules"))
        .pipe(Effect.orElseSucceed(() => true));
      if (hasSubmodules) return false;
      return yield* colocatedGitCommand(deps.process, operation, { gitDir, cwd }, [
        ...durableWrite,
        "update-ref",
        toCheckpointRef,
        commit,
        "",
      ]).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.flatMap(resolveRefCommit(gitDir, cwd, toCheckpointRef), (existing) =>
            existing === null ? Effect.fail(error) : Effect.succeed(true),
          ),
        ),
      );
    }),

    restoreCheckpoint: Effect.fn("JjVcsDriver.checkpoints.restoreCheckpoint")(function* (input) {
      const operation = "JjVcsDriver.checkpoints.restoreCheckpoint";
      const gitDir = yield* deps.ensureGitDir(operation, input.cwd);

      const captured = yield* resolveRefCommit(gitDir, input.cwd, input.checkpointRef);
      // `@-`, not `@`: `jj restore --from <@'s own commit id>` changes nothing and reports success.
      // It is absent, never the all-zeros root commit, in a repository with no commits.
      const commitId =
        captured ??
        (input.fallbackToHead === true
          ? ((yield* deps.currentChange(input.cwd)).parentCommitIds[0] ?? null)
          : null);

      if (commitId === null) {
        return false;
      }

      const restored = yield* restoreFrom(operation, input.cwd, commitId);
      if (restored.exitCode === 0) {
        return true;
      }

      if (!MISSING_REVISION_PATTERN.test(restored.stderr)) {
        return yield* new VcsProcessExitError({
          operation,
          command: "jj restore",
          cwd: input.cwd,
          exitCode: restored.exitCode,
          detail: restored.stderr.trim() || "jj restore failed.",
        });
      }

      yield* restoreThroughGitObject(operation, gitDir, input.cwd, commitId);
      return true;
    }),

    diffCheckpoints: Effect.fn("JjVcsDriver.checkpoints.diffCheckpoints")(function* (input) {
      const operation = "JjVcsDriver.checkpoints.diffCheckpoints";
      yield* Effect.annotateCurrentSpan({
        "checkpoint.cwd": input.cwd,
        "checkpoint.from_ref": input.fromCheckpointRef,
        "checkpoint.to_ref": input.toCheckpointRef,
        "checkpoint.ignore_whitespace": input.ignoreWhitespace,
        "checkpoint.format": input.format ?? "patch",
        "checkpoint.fallback_from_to_head": input.fallbackFromToHead,
      });
      const gitDir = yield* deps.ensureGitDir(operation, input.cwd);

      const [capturedFrom, toOid] = yield* Effect.all([
        resolveRefCommit(gitDir, input.cwd, input.fromCheckpointRef),
        resolveRefCommit(gitDir, input.cwd, input.toCheckpointRef),
      ]);
      const fromOid =
        capturedFrom ??
        (input.fallbackFromToHead === true
          ? ((yield* deps.currentChange(input.cwd)).parentCommitIds[0] ?? EMPTY_TREE_OID)
          : null);

      if (fromOid === null || toOid === null) {
        return yield* new VcsProcessExitError({
          operation,
          command: "git diff",
          cwd: input.cwd,
          exitCode: 1,
          detail: CHECKPOINT_REF_UNAVAILABLE_DETAIL,
        });
      }

      const result = yield* colocatedGitCommand(
        deps.process,
        operation,
        { gitDir, cwd: input.cwd },
        [
          "diff",
          ...(input.format === "numstat" ? ["--numstat", "-z"] : ["--patch"]),
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          ...PATCH_RENDER_PREFIX_ARGS,
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          fromOid,
          toOid,
          ...JJ_CONFLICT_PATHSPECS,
        ],
        {
          allowNonZeroExit: true,
          maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
          outputMode: input.format === "numstat" ? "error" : "truncate",
        },
      );

      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation,
          command: "git diff",
          cwd: input.cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || CHECKPOINT_REF_UNAVAILABLE_DETAIL,
        });
      }

      return result.stdout;
    }),

    deleteCheckpointRefs: Effect.fn("JjVcsDriver.checkpoints.deleteCheckpointRefs")(
      function* (input) {
        const operation = "JjVcsDriver.checkpoints.deleteCheckpointRefs";
        const gitDir = yield* deps.ensureGitDir(operation, input.cwd);

        yield* Effect.forEach(
          input.checkpointRefs,
          (checkpointRef) =>
            colocatedGitCommand(
              deps.process,
              operation,
              { gitDir, cwd: input.cwd },
              ["update-ref", "-d", checkpointRef],
              { allowNonZeroExit: true },
            ),
          { discard: true },
        );
      },
    ),
  };
};
