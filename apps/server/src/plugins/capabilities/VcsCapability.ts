// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { GitCommandError } from "@t3tools/contracts";
import type { VcsCapability, VcsRef, VcsWorktreeSummary } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { CheckpointStore } from "../../checkpointing/CheckpointStore.ts";
import type * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import type { PluginWorkspaceGrants } from "../PluginWorkspaceGrants.ts";

export class PluginVcsPathError extends Schema.TaggedErrorClass<PluginVcsPathError>()(
  "PluginVcsPathError",
  {
    field: Schema.String,
    path: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `VCS path '${this.field}' is not allowed (${this.reason}): ${this.path}`;
  }
}

// Refs, branch names, and remote names are plugin-supplied DATA that end up in
// git *option* position (`git merge <ref>`, `git branch <name>`, `rev-list
// <base>..<head>`, `update-ref <checkpointRef> ...`). A value like
// `--output=/abs/path` would be honored by git as an option — an arbitrary
// write primitive — because options parse before any `--` pathspec separator.
// Git ref names can never legitimately begin with `-` (check-ref-format
// rejects them), so reject those plus empty/NUL values here, and additionally
// pass `--end-of-options` wherever this facade builds the argv itself.
export class PluginVcsRefError extends Schema.TaggedErrorClass<PluginVcsRefError>()(
  "PluginVcsRefError",
  {
    field: Schema.String,
    ref: Schema.String,
  },
) {
  override get message(): string {
    return `VCS ref '${this.field}' is not a valid ref name: ${JSON.stringify(this.ref)}`;
  }
}

const requireAbsolute = (field: string, path: string): Effect.Effect<string, PluginVcsPathError> =>
  NodePath.isAbsolute(path)
    ? Effect.succeed(path)
    : Effect.fail(new PluginVcsPathError({ field, path, reason: "must be absolute" }));

const requireSafeRef = (field: string, ref: string): Effect.Effect<string, PluginVcsRefError> =>
  ref.length === 0 || ref.startsWith("-") || ref.includes("\0")
    ? Effect.fail(new PluginVcsRefError({ field, ref }))
    : Effect.succeed(ref);

const isAbsoluteLike = (value: string): boolean =>
  NodePath.isAbsolute(value) || value.startsWith("\\") || /^[a-zA-Z]:[\\/]/u.test(value);

// Sub-paths (removePath / clean / commit filePaths) are pathspecs resolved by
// git against the worktree cwd. Reject NUL bytes, absolute paths, and `..`
// segments so a data-controlled path cannot direct the operation at a parent
// or arbitrary location outside the already-contained worktree root. Mirrors
// the filesystem capability's parseRelativePath discipline.
const requireRepoRelative = (
  field: string,
  value: string,
): Effect.Effect<string, PluginVcsPathError> => {
  if (value.includes("\0")) {
    return Effect.fail(
      new PluginVcsPathError({ field, path: value, reason: "contains a NUL byte" }),
    );
  }
  if (isAbsoluteLike(value)) {
    return Effect.fail(
      new PluginVcsPathError({ field, path: value, reason: "must be relative to the worktree" }),
    );
  }
  const segments = value
    .replace(/\\/gu, "/")
    .split("/")
    .filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.includes("..")) {
    return Effect.fail(
      new PluginVcsPathError({ field, path: value, reason: "must not escape the worktree" }),
    );
  }
  return Effect.succeed(value);
};

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
  const props = {
    operation: input.operation,
    command: "git",
    cwd: input.cwd,
    argumentCount: input.args.length,
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    ...(input.stdout !== undefined ? { stdoutLength: input.stdout.length } : {}),
    detail: input.detail,
  };
  // Raw stderr rides along as a server-side-only property (never serialized
  // to the RPC wire) so in-process consumers can still classify the failure.
  return input.stderr !== undefined
    ? GitCommandError.withStderr(props, input.stderr)
    : new GitCommandError(props);
}

export function makeVcsCapability(input: {
  readonly git: GitVcsDriver.GitVcsDriver["Service"];
  readonly checkpoints: CheckpointStore["Service"];
  readonly snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  readonly grants: PluginWorkspaceGrants;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  // Server-managed base directory for worktrees (ServerConfig.worktreesDir):
  // the one location outside the granted roots where createWorktree may place
  // a NEW worktree (which is then granted, admitting every later operation on
  // it). Mirrors the GitVcsDriver default worktree location.
  readonly worktreesDir: string;
}): VcsCapability {
  const { path } = input;

  const contains = (realRoot: string, realTarget: string): boolean => {
    const relative = path.relative(realRoot, realTarget);
    // NOT `relative.startsWith("..")`: that also matches legitimate in-root names
    // that merely BEGIN with two dots — `..cache`, `..config` — which realPath had
    // already confirmed are inside the granted root. Only an exact ".." or a leading
    // "../" segment means the target escaped.
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  // Roots the plugin may run git in: projected project workspace roots plus
  // worktrees this plugin created through createWorktree. Same containment
  // model as the filesystem and sourceControl capabilities — real-path both
  // sides so symlinks/`..` cannot dodge the check.
  const grantedRealRoots = Effect.gen(function* () {
    const shell = yield* input.snapshots.getShellSnapshot();
    const projectRoots = shell.projects.map((project) => project.workspaceRoot);
    const roots = [...new Set([...projectRoots, ...(yield* input.grants.snapshot())])];
    const realRoots: string[] = [];
    for (const root of roots) {
      const realRoot = yield* input.fileSystem.realPath(root).pipe(Effect.option);
      if (Option.isSome(realRoot)) realRoots.push(realRoot.value);
    }
    return realRoots;
  });

  const assertWithinRealRoots = (
    field: string,
    value: string,
    realRoots: ReadonlyArray<string>,
  ): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      const realTarget = yield* input.fileSystem
        .realPath(value)
        .pipe(
          Effect.mapError(
            () => new PluginVcsPathError({ field, path: value, reason: "does not resolve" }),
          ),
        );
      if (realRoots.some((realRoot) => contains(realRoot, realTarget))) {
        return;
      }
      return yield* new PluginVcsPathError({
        field,
        path: value,
        reason: "outside the plugin's granted workspace roots",
      });
    });

  // Every operation that runs git in an EXISTING repo/worktree goes through
  // this: absolute + real-path contained in a granted root. Returns the
  // caller-supplied path (not the real path) so git sees the same cwd the
  // caller named.
  const requireGrantedRoot = (field: string, value: string): Effect.Effect<string, Error> =>
    Effect.gen(function* () {
      yield* requireAbsolute(field, value);
      const realRoots = yield* grantedRealRoots;
      yield* assertWithinRealRoots(field, value, realRoots);
      return value;
    });

  // Real-path the nearest EXISTING ancestor of a not-yet-created path. The
  // input is lexically normalized first (no `..` survives), so the un-created
  // suffix below the anchor cannot escape it, and realpathing the anchor keeps
  // symlinked ancestors from smuggling the target outside an allowed root.
  const nearestExistingAncestorRealPath = (
    field: string,
    absolutePath: string,
  ): Effect.Effect<string, PluginVcsPathError> =>
    Effect.gen(function* () {
      let candidate = absolutePath;
      for (;;) {
        const real = yield* input.fileSystem.realPath(candidate).pipe(Effect.option);
        if (Option.isSome(real)) return real.value;
        const parent = path.dirname(candidate);
        if (parent === candidate) {
          return yield* new PluginVcsPathError({
            field,
            path: absolutePath,
            reason: "does not resolve",
          });
        }
        candidate = parent;
      }
    });

  const executeDiff = (request: {
    readonly worktreePath: string;
    readonly args: ReadonlyArray<string>;
  }) =>
    requireGrantedRoot("worktreePath", request.worktreePath).pipe(
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
      requireGrantedRoot("worktreePath", worktreePath).pipe(
        Effect.flatMap((cwd) => input.git.status({ cwd })),
      ),

    listWorktrees: ({ repoRoot }) =>
      requireGrantedRoot("repoRoot", repoRoot).pipe(
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
        const cwd = yield* requireGrantedRoot("repoRoot", request.repoRoot);
        yield* requireSafeRef("ref", request.ref);
        if (request.newBranch !== undefined) {
          yield* requireSafeRef("newBranch", request.newBranch);
        }
        if (request.baseRef !== undefined) {
          yield* requireSafeRef("baseRef", request.baseRef);
        }
        const worktreePath = path.normalize(yield* requireAbsolute("path", request.path));
        // The new worktree may not exist yet, so containment is asserted on
        // its nearest existing ancestor: inside a granted root, or inside the
        // server-managed worktrees base dir (the standard location). Anything
        // else would let data-controlled paths write a checkout to an
        // arbitrary filesystem location.
        const realRoots = yield* grantedRealRoots;
        const worktreesRealRoot = yield* input.fileSystem
          .realPath(input.worktreesDir)
          .pipe(Effect.option);
        const anchor = yield* nearestExistingAncestorRealPath("path", worktreePath);
        const inGrantedRoot = realRoots.some((root) => contains(root, anchor));
        // Via the server-managed worktrees dir, only a path whose nearest EXISTING
        // ancestor is the worktrees dir ITSELF is acceptable — i.e. a fresh sibling.
        // "Contained in the worktrees dir" was too weak: for
        // `<worktreesDir>/<other-worktree>/subdir` the nearest existing ancestor is
        // the OTHER worktree, which is contained — so a plugin could plant a checkout
        // inside a worktree it was never granted, and the grant issued at the end
        // would then hand it that subtree.
        const isFreshWorktreeSibling =
          Option.isSome(worktreesRealRoot) && anchor === worktreesRealRoot.value;
        if (!inGrantedRoot && !isFreshWorktreeSibling) {
          return yield* new PluginVcsPathError({
            field: "path",
            path: request.path,
            reason:
              "outside the plugin's granted workspace roots, and not a new entry directly under the worktrees directory",
          });
        }
        const result = yield* input.git.createWorktree({
          cwd,
          refName: request.ref,
          newRefName: request.newBranch,
          baseRefName: request.baseRef,
          path: worktreePath,
        });
        yield* input.grants.grant(result.worktree.path ?? worktreePath);
        return result;
      }),

    removeWorktree: (request) =>
      Effect.gen(function* () {
        const cwd = yield* requireGrantedRoot("repoRoot", request.repoRoot);
        // The worktree being removed must itself be granted (it was granted at
        // create time, or lives inside a project root).
        const worktreePath = yield* requireGrantedRoot("path", request.path);
        yield* input.git.removeWorktree({
          cwd,
          path: worktreePath,
          force: request.force,
        });
        yield* input.grants.revoke(worktreePath);
      }),

    createBranch: (request) =>
      Effect.gen(function* () {
        const cwd = yield* requireGrantedRoot("worktreePath", request.worktreePath);
        yield* requireSafeRef("branch", request.branch);
        return yield* input.git.createRef({
          cwd,
          refName: request.branch,
          switchRef: request.switch,
        });
      }),

    switchRef: (request) =>
      Effect.gen(function* () {
        const cwd = yield* requireGrantedRoot("worktreePath", request.worktreePath);
        yield* requireSafeRef("ref", request.ref);
        return yield* input.git.switchRef({
          cwd,
          refName: request.ref,
        });
      }),

    removePath: (request) =>
      Effect.gen(function* () {
        const cwd = yield* requireGrantedRoot("worktreePath", request.worktreePath);
        yield* requireRepoRelative("path", request.path);
        yield* input.git.execute({
          operation: "PluginVcsCapability.removePath",
          cwd,
          args: ["rm", "-r", "-f", "--ignore-unmatch", "--", request.path],
        });
      }),

    clean: (request) =>
      Effect.gen(function* () {
        const cwd = yield* requireGrantedRoot("worktreePath", request.worktreePath);
        yield* requireRepoRelative("path", request.path);
        yield* input.git.execute({
          operation: "PluginVcsCapability.clean",
          cwd,
          args: ["clean", "-f", "-d", "--", request.path],
        });
      }),

    currentBranch: ({ worktreePath }) =>
      requireGrantedRoot("worktreePath", worktreePath).pipe(
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
      Effect.gen(function* () {
        const cwd = yield* requireGrantedRoot("worktreePath", request.worktreePath);
        yield* requireSafeRef("base", request.base);
        yield* requireSafeRef("head", request.head);
        const args = [
          "rev-list",
          "--count",
          "--end-of-options",
          `${request.base}..${request.head}`,
        ];
        const result = yield* input.git.execute({
          operation: "PluginVcsCapability.aheadCount",
          cwd,
          args,
        });
        const count = Number.parseInt(result.stdout.trim(), 10);
        return Number.isFinite(count)
          ? count
          : yield* gitCommandError({
              operation: "PluginVcsCapability.aheadCount",
              cwd: request.worktreePath,
              args,
              stdout: result.stdout,
              stderr: result.stderr,
              detail: "git rev-list returned a non-numeric count",
            });
      }),

    listRefs: ({ repoRoot }) =>
      requireGrantedRoot("repoRoot", repoRoot).pipe(
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
        const cwd = yield* requireGrantedRoot("worktreePath", request.worktreePath);
        if (request.filePaths !== undefined) {
          yield* Effect.forEach(request.filePaths, (filePath) =>
            requireRepoRelative("filePaths", filePath),
          );
        }
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
        const cwd = yield* requireGrantedRoot("worktreePath", request.worktreePath);
        yield* requireSafeRef("ref", request.ref);
        const args = [
          "merge",
          ...(request.noFf ? ["--no-ff"] : []),
          ...(request.noVerify ? ["--no-verify"] : []),
          ...(request.message ? ["-m", request.message] : []),
          "--end-of-options",
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
            // Best-effort, like the non-conflict path below: a nonzero abort
            // must not turn the conflict VALUE into a GitCommandError — the
            // caller would lose the conflictedFiles detail it asked for.
            yield* input.git
              .execute({
                operation: "PluginVcsCapability.merge.abort",
                cwd,
                args: ["merge", "--abort"],
              })
              .pipe(Effect.ignore);
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
      Effect.gen(function* () {
        const cwd = yield* requireGrantedRoot("worktreePath", request.worktreePath);
        if (request.fallbackBranch !== undefined && request.fallbackBranch !== null) {
          yield* requireSafeRef("fallbackBranch", request.fallbackBranch);
        }
        if (request.remoteName !== undefined && request.remoteName !== null) {
          yield* requireSafeRef("remoteName", request.remoteName);
        }
        return yield* input.git.pushCurrentBranch(cwd, request.fallbackBranch ?? null, {
          remoteName: request.remoteName ?? null,
        });
      }),

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
      Effect.gen(function* () {
        yield* requireSafeRef("fromRef", request.fromRef);
        yield* requireSafeRef("toRef", request.toRef);
        return yield* executeDiff({
          worktreePath: request.worktreePath,
          args: [
            "diff",
            "--no-ext-diff",
            "--patch",
            "--minimal",
            ...(request.ignoreWhitespace ? ["--ignore-all-space"] : []),
            "--end-of-options",
            `${request.fromRef}..${request.toRef}`,
          ],
        });
      }),

    // Diff a caller-supplied base ref against the live working tree (tracked
    // uncommitted state) plus, by default, untracked files as `/dev/null` add
    // diffs. Mirrors the fork's WorktreeDiffPort.diffRefToWorktree: three bounded
    // git invocations (tracked diff, untracked list, per-untracked add-diff),
    // concatenated, with `truncated` OR'd across all segments.
    diffRefToWorkingTree: (request) =>
      Effect.gen(function* () {
        const cwd = yield* requireGrantedRoot("worktreePath", request.worktreePath);
        yield* requireSafeRef("baseRef", request.baseRef);
        const wsArgs = request.ignoreWhitespace ? ["--ignore-all-space"] : [];
        const tracked = yield* input.git.execute({
          operation: "PluginVcsCapability.diffRefToWorkingTree.tracked",
          cwd,
          args: [
            "diff",
            "--no-ext-diff",
            "--patch",
            "--minimal",
            ...wsArgs,
            "--end-of-options",
            `${request.baseRef}^{commit}`,
            "--",
          ],
          maxOutputBytes: 120_000,
          appendTruncationMarker: true,
        });

        const includeUntracked = request.includeUntracked !== false;
        const untrackedList = includeUntracked
          ? yield* input.git
              .execute({
                operation: "PluginVcsCapability.diffRefToWorkingTree.untracked.list",
                cwd,
                args: ["ls-files", "--others", "--exclude-standard", "-z"],
                maxOutputBytes: 120_000,
                appendTruncationMarker: true,
              })
              .pipe(Effect.orElseSucceed(() => ({ stdout: "", stdoutTruncated: false })))
          : { stdout: "", stdoutTruncated: false };
        const untrackedPaths = untrackedList.stdout.split("\0").filter((p) => p.length > 0);
        // One SHARED budget across every untracked diff, matching the cap the tracked
        // half already has. Without it each PATH in the (120KB-capped) listing spawned
        // its own 120KB-capped diff and everything was concatenated — ~12k short
        // paths made one plugin call allocate gigabytes and could OOM the server.
        // `concurrency: 4` bounds simultaneous git processes, not memory. Once the
        // budget is spent, remaining paths are skipped without spawning git at all
        // and the result is marked truncated. (With 4 in flight the overshoot is at
        // most 4 capped outputs — bounded, which is the property that matters.)
        const untrackedBudget = yield* Ref.make(120_000);
        const untrackedDiffs = yield* Effect.forEach(
          untrackedPaths,
          (untrackedPath) =>
            Effect.gen(function* () {
              const remaining = yield* Ref.get(untrackedBudget);
              if (remaining <= 0) {
                return { stdout: "", stdoutTruncated: true };
              }
              const result = yield* input.git.execute({
                operation: "PluginVcsCapability.diffRefToWorkingTree.untracked.diff",
                cwd,
                args: [
                  "diff",
                  "--no-ext-diff",
                  "--no-index",
                  "--patch",
                  "--minimal",
                  ...wsArgs,
                  "--",
                  "/dev/null",
                  untrackedPath,
                ],
                allowNonZeroExit: true,
                maxOutputBytes: Math.min(120_000, remaining),
                appendTruncationMarker: true,
              });
              yield* Ref.update(untrackedBudget, (budget) => budget - result.stdout.length);
              return result;
            }),
          { concurrency: 4 },
        );

        return {
          diff: [
            tracked.stdout.trimEnd(),
            ...untrackedDiffs.map((result) => result.stdout.trimEnd()),
          ]
            .filter((part) => part.length > 0)
            .join("\n"),
          truncated:
            tracked.stdoutTruncated ||
            untrackedList.stdoutTruncated ||
            untrackedDiffs.some((result) => result.stdoutTruncated),
        };
      }),

    createCheckpoint: (request) =>
      Effect.gen(function* () {
        const cwd = yield* requireGrantedRoot("worktreePath", request.worktreePath);
        yield* requireSafeRef("checkpointRef", request.checkpointRef);
        return yield* input.checkpoints.captureCheckpoint({
          cwd,
          checkpointRef: request.checkpointRef,
        });
      }),

    hasCheckpoint: (request) =>
      Effect.gen(function* () {
        const cwd = yield* requireGrantedRoot("worktreePath", request.worktreePath);
        yield* requireSafeRef("checkpointRef", request.checkpointRef);
        return yield* input.checkpoints.hasCheckpointRef({
          cwd,
          checkpointRef: request.checkpointRef,
        });
      }),

    restoreCheckpoint: (request) =>
      Effect.gen(function* () {
        const cwd = yield* requireGrantedRoot("worktreePath", request.worktreePath);
        yield* requireSafeRef("checkpointRef", request.checkpointRef);
        const restored = yield* input.checkpoints.restoreCheckpoint({
          cwd,
          checkpointRef: request.checkpointRef,
          fallbackToHead: request.fallbackToHead ?? false,
        });
        return { restored };
      }),

    deleteCheckpoints: (request) =>
      Effect.gen(function* () {
        const cwd = yield* requireGrantedRoot("worktreePath", request.worktreePath);
        yield* Effect.forEach(request.checkpointRefs, (checkpointRef) =>
          requireSafeRef("checkpointRefs", checkpointRef),
        );
        return yield* input.checkpoints.deleteCheckpointRefs({
          cwd,
          checkpointRefs: request.checkpointRefs,
        });
      }),
  };
}
