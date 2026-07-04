// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { GitCommandError } from "@t3tools/contracts";
import type { VcsCapability, VcsRef, VcsWorktreeSummary } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { CheckpointStore } from "../../checkpointing/CheckpointStore.ts";
import type * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import type { PluginWorkspaceGrants } from "../PluginWorkspaceGrants.ts";

export class PluginVcsPathError extends Schema.TaggedErrorClass<PluginVcsPathError>()(
  "PluginVcsPathError",
  {
    field: Schema.String,
    path: Schema.String,
  },
) {
  override get message(): string {
    return `VCS path '${this.field}' must be absolute: ${this.path}`;
  }
}

const requireAbsolute = (field: string, path: string): Effect.Effect<string, PluginVcsPathError> =>
  NodePath.isAbsolute(path)
    ? Effect.succeed(path)
    : Effect.fail(new PluginVcsPathError({ field, path }));

function parseWorktreeList(stdout: string): ReadonlyArray<VcsWorktreeSummary> {
  const worktrees: VcsWorktreeSummary[] = [];
  let current: {
    path?: string;
    branch?: string | null;
    head?: string | null;
    detached?: boolean;
    bare?: boolean;
  } = {};

  const flush = () => {
    if (!current.path) {
      current = {};
      return;
    }
    worktrees.push({
      path: current.path,
      branch: current.branch ?? null,
      head: current.head ?? null,
      detached: current.detached ?? false,
      bare: current.bare ?? false,
    });
    current = {};
  };

  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "bare") {
      current.bare = true;
    }
  }
  flush();
  return worktrees;
}

function gitCommandError(input: {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly exitCode?: number | undefined;
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
  readonly detail: string;
}) {
  return new GitCommandError({
    operation: input.operation,
    command: "git",
    cwd: input.cwd,
    argumentCount: input.args.length,
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    ...(input.stdout !== undefined ? { stdoutLength: input.stdout.length } : {}),
    ...(input.stderr !== undefined ? { stderrLength: input.stderr.length } : {}),
    detail: input.detail,
  });
}

export function makeVcsCapability(input: {
  readonly git: GitVcsDriver.GitVcsDriver["Service"];
  readonly checkpoints: CheckpointStore["Service"];
  readonly grants?: PluginWorkspaceGrants | undefined;
}): VcsCapability {
  const executeDiff = (request: {
    readonly worktreePath: string;
    readonly args: ReadonlyArray<string>;
  }) =>
    requireAbsolute("worktreePath", request.worktreePath).pipe(
      Effect.flatMap((cwd) =>
        input.git.execute({
          operation: "PluginVcsCapability.diff",
          cwd,
          args: request.args,
          maxOutputBytes: 10_000_000,
          appendTruncationMarker: true,
        }),
      ),
      Effect.map((result) => ({ diff: result.stdout })),
    );

  return {
    status: ({ worktreePath }) =>
      requireAbsolute("worktreePath", worktreePath).pipe(
        Effect.flatMap((cwd) => input.git.status({ cwd })),
      ),

    listWorktrees: ({ repoRoot }) =>
      requireAbsolute("repoRoot", repoRoot).pipe(
        Effect.flatMap((cwd) =>
          input.git.execute({
            operation: "PluginVcsCapability.listWorktrees",
            cwd,
            args: ["worktree", "list", "--porcelain"],
          }),
        ),
        Effect.map((result) => ({ worktrees: parseWorktreeList(result.stdout) })),
      ),

    createWorktree: (request) =>
      Effect.gen(function* () {
        const cwd = yield* requireAbsolute("repoRoot", request.repoRoot);
        const path = yield* requireAbsolute("path", request.path);
        const result = yield* input.git.createWorktree({
          cwd,
          refName: request.ref,
          newRefName: request.newBranch,
          baseRefName: request.baseRef,
          path,
        });
        if (input.grants) {
          yield* input.grants.grant(result.worktree.path ?? path);
        }
        return result;
      }),

    removeWorktree: (request) =>
      Effect.gen(function* () {
        const cwd = yield* requireAbsolute("repoRoot", request.repoRoot);
        const path = yield* requireAbsolute("path", request.path);
        yield* input.git.removeWorktree({
          cwd,
          path,
          force: request.force,
        });
        if (input.grants) {
          yield* input.grants.revoke(path);
        }
      }),

    createBranch: (request) =>
      requireAbsolute("worktreePath", request.worktreePath).pipe(
        Effect.flatMap((cwd) =>
          input.git.createRef({
            cwd,
            refName: request.branch,
            switchRef: request.switch,
          }),
        ),
      ),

    switchRef: (request) =>
      requireAbsolute("worktreePath", request.worktreePath).pipe(
        Effect.flatMap((cwd) =>
          input.git.switchRef({
            cwd,
            refName: request.ref,
          }),
        ),
      ),

    removePath: (request) =>
      requireAbsolute("worktreePath", request.worktreePath).pipe(
        Effect.flatMap((cwd) =>
          input.git.execute({
            operation: "PluginVcsCapability.removePath",
            cwd,
            args: ["rm", "-r", "-f", "--ignore-unmatch", "--", request.path],
          }),
        ),
        Effect.asVoid,
      ),

    clean: (request) =>
      requireAbsolute("worktreePath", request.worktreePath).pipe(
        Effect.flatMap((cwd) =>
          input.git.execute({
            operation: "PluginVcsCapability.clean",
            cwd,
            args: ["clean", "-f", "-d", "--", request.path],
          }),
        ),
        Effect.asVoid,
      ),

    currentBranch: ({ worktreePath }) =>
      requireAbsolute("worktreePath", worktreePath).pipe(
        Effect.flatMap((cwd) =>
          input.git.execute({
            operation: "PluginVcsCapability.currentBranch",
            cwd,
            args: ["rev-parse", "--abbrev-ref", "HEAD"],
          }),
        ),
        Effect.map((result) => result.stdout.trim()),
      ),

    aheadCount: (request) =>
      requireAbsolute("worktreePath", request.worktreePath).pipe(
        Effect.flatMap((cwd) =>
          input.git.execute({
            operation: "PluginVcsCapability.aheadCount",
            cwd,
            args: ["rev-list", "--count", `${request.base}..${request.head}`],
          }),
        ),
        Effect.flatMap((result) => {
          const count = Number.parseInt(result.stdout.trim(), 10);
          return Number.isFinite(count)
            ? Effect.succeed(count)
            : Effect.fail(
                gitCommandError({
                  operation: "PluginVcsCapability.aheadCount",
                  cwd: request.worktreePath,
                  args: ["rev-list", "--count", `${request.base}..${request.head}`],
                  stdout: result.stdout,
                  stderr: result.stderr,
                  detail: "git rev-list returned a non-numeric count",
                }),
              );
        }),
      ),

    listRefs: ({ repoRoot }) =>
      requireAbsolute("repoRoot", repoRoot).pipe(
        Effect.flatMap((cwd) => input.git.listRefs({ cwd })),
        Effect.map(
          (result): ReadonlyArray<VcsRef> =>
            result.refs.map((ref) => ({
              name: ref.name,
              isRemote: ref.isRemote ?? false,
              worktreePath: ref.worktreePath,
            })),
        ),
      ),

    commit: (request) =>
      Effect.gen(function* () {
        const cwd = yield* requireAbsolute("worktreePath", request.worktreePath);
        const context = yield* input.git.prepareCommitContext(cwd, request.filePaths);
        if (context === null) {
          return { status: "skipped_no_changes" as const };
        }
        const result = yield* input.git.commit(
          cwd,
          request.subject,
          request.body ?? "",
          request.noVerify ? { noVerify: true } : {},
        );
        return {
          status: "created" as const,
          commitSha: result.commitSha,
        };
      }),

    merge: (request) =>
      Effect.gen(function* () {
        const cwd = yield* requireAbsolute("worktreePath", request.worktreePath);
        const args = [
          "merge",
          ...(request.noFf ? ["--no-ff"] : []),
          ...(request.noVerify ? ["--no-verify"] : []),
          ...(request.message ? ["-m", request.message] : []),
          request.ref,
        ];
        const result = yield* input.git.execute({
          operation: "PluginVcsCapability.merge",
          cwd,
          args,
          allowNonZeroExit: true,
          maxOutputBytes: 1_000_000,
          appendTruncationMarker: true,
        });
        if (result.exitCode === 0) {
          const commitSha = yield* input.git
            .execute({
              operation: "PluginVcsCapability.merge.revParseHead",
              cwd,
              args: ["rev-parse", "HEAD"],
            })
            .pipe(Effect.map((head) => head.stdout.trim()));
          return {
            status: "merged" as const,
            commitSha,
            stdout: result.stdout,
            stderr: result.stderr,
          };
        }

        const conflicts = yield* input.git.execute({
          operation: "PluginVcsCapability.merge.conflicts",
          cwd,
          args: ["diff", "--name-only", "--diff-filter=U"],
          allowNonZeroExit: true,
        });
        const conflictedFiles = conflicts.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        if (conflictedFiles.length > 0) {
          if (request.abortOnConflict) {
            yield* input.git
              .execute({
                operation: "PluginVcsCapability.merge.abort",
                cwd,
                args: ["merge", "--abort"],
              })
              .pipe(Effect.asVoid);
          }
          return {
            status: "conflict" as const,
            conflictedFiles,
            stdout: result.stdout,
            stderr: result.stderr,
          };
        }

        if (request.abortOnConflict) {
          // A non-conflict merge failure may still have left MERGE_HEAD (fork
          // aborts on any nonzero exit). Abort best-effort so the tree returns
          // clean; ignore the abort's own error since a precondition failure
          // (e.g. a bad ref) may leave no merge in progress to abort.
          yield* input.git
            .execute({
              operation: "PluginVcsCapability.merge.abort",
              cwd,
              args: ["merge", "--abort"],
            })
            .pipe(Effect.ignore);
        }
        return yield* gitCommandError({
          operation: "PluginVcsCapability.merge",
          cwd,
          args,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          detail: result.stderr.trim() || "git merge failed",
        });
      }),

    push: (request) =>
      requireAbsolute("worktreePath", request.worktreePath).pipe(
        Effect.flatMap((cwd) =>
          input.git.pushCurrentBranch(cwd, request.fallbackBranch ?? null, {
            remoteName: request.remoteName ?? null,
          }),
        ),
      ),

    workingTreeDiff: (request) =>
      executeDiff({
        worktreePath: request.worktreePath,
        args: [
          "diff",
          "--no-ext-diff",
          "--patch",
          "--minimal",
          ...(request.staged ? ["--cached"] : []),
          ...(request.ignoreWhitespace ? ["--ignore-all-space"] : []),
        ],
      }),

    diffRefs: (request) =>
      executeDiff({
        worktreePath: request.worktreePath,
        args: [
          "diff",
          "--no-ext-diff",
          "--patch",
          "--minimal",
          ...(request.ignoreWhitespace ? ["--ignore-all-space"] : []),
          `${request.fromRef}..${request.toRef}`,
        ],
      }),

    createCheckpoint: (request) =>
      requireAbsolute("worktreePath", request.worktreePath).pipe(
        Effect.flatMap((cwd) =>
          input.checkpoints.captureCheckpoint({
            cwd,
            checkpointRef: request.checkpointRef,
          }),
        ),
      ),

    hasCheckpoint: (request) =>
      requireAbsolute("worktreePath", request.worktreePath).pipe(
        Effect.flatMap((cwd) =>
          input.checkpoints.hasCheckpointRef({
            cwd,
            checkpointRef: request.checkpointRef,
          }),
        ),
      ),

    restoreCheckpoint: (request) =>
      requireAbsolute("worktreePath", request.worktreePath).pipe(
        Effect.flatMap((cwd) =>
          input.checkpoints.restoreCheckpoint({
            cwd,
            checkpointRef: request.checkpointRef,
            fallbackToHead: request.fallbackToHead ?? false,
          }),
        ),
        Effect.map((restored) => ({ restored })),
      ),

    deleteCheckpoints: (request) =>
      requireAbsolute("worktreePath", request.worktreePath).pipe(
        Effect.flatMap((cwd) =>
          input.checkpoints.deleteCheckpointRefs({
            cwd,
            checkpointRefs: request.checkpointRefs,
          }),
        ),
      ),
  };
}
