// @effect-diagnostics nodeBuiltinImport:off - the three exported name/path helpers are pure, so
// they cannot take the Path service; the operations below use the injected one.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

import { T3_PROJECT_FILE_NAME } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveProjectFileBackedSetting } from "@t3tools/shared/projectSettings";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import type { VcsWorkflowOps } from "../git/GitWorkflowService.ts";
import * as JjProcess from "../vcs/JjProcess.ts";
import type { JjRepoPaths } from "../vcs/JjRepo.ts";
import { bookmarkNameArgument, refNameToRevset, splitRemoteRefName } from "../vcs/JjRevset.ts";
import type { JjSegmentRow, JjVcsDriverShape } from "../vcs/JjVcsDriver.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";
import { jjFailure, mapJjFailure } from "./JjFailure.ts";
import {
  assertBookmarkUsable,
  trackRemoteBookmark,
  writeBookmarkUpstreamConfig,
  type JjRemoteOps,
} from "./JjRemotes.ts";
import { resolveWorkspaceRefName, strandedSegmentRows } from "./JjStatus.ts";

const WORKSPACE_NAME_PREFIX = "t3-";
const WORKSPACE_DIGEST_LENGTH = 8;
const WORKSPACE_ADD_TIMEOUT_MS = 300_000;
const WORKSPACE_NAME_PATTERN = new RegExp(
  `^${WORKSPACE_NAME_PREFIX}.+-[0-9a-f]{${WORKSPACE_DIGEST_LENGTH}}$`,
);

function bookmarkDigest(refName: string): string {
  return NodeCrypto.createHash("sha256")
    .update(refName)
    .digest("hex")
    .slice(0, WORKSPACE_DIGEST_LENGTH);
}

/**
 * `t3-<bookmark with "/" → "-">-<8 hex of sha256(bookmark)>`. The digest is not decoration:
 * without it `a/b` and `a-b` both map to `t3-a-b`, the second `jj workspace add` fails on the
 * duplicate name, and `listRefs` attributes one workspace root to two bookmarks.
 */
export function workspaceNameForRef(refName: string): string {
  return `${WORKSPACE_NAME_PREFIX}${refName.replaceAll("/", "-")}-${bookmarkDigest(refName)}`;
}

/** True for any name {@link workspaceNameForRef} could have produced. Never true for `default`. */
export function isT3WorkspaceName(name: string): boolean {
  return WORKSPACE_NAME_PATTERN.test(name);
}

/**
 * `<worktreesDir>/<repoName>/<refName with "/" → "-">`, the layout
 * `AgentSessionScanner.isT3ManagedWorktree` and `ReviewService.assertWorkspaceBoundCwd` classify
 * by string prefix. A workspace outside it stops being recognised as a thread environment.
 */
export function defaultWorkspacePathForRef(input: {
  readonly worktreesDir: string;
  readonly mainWorkspaceRoot: string;
  readonly refName: string;
}): string {
  return NodePath.join(
    input.worktreesDir,
    NodePath.basename(input.mainWorkspaceRoot),
    input.refName.replaceAll("/", "-"),
  );
}

export interface JjWorkspaceOpsDeps {
  readonly driver: JjVcsDriverShape;
  readonly process: VcsProcess.VcsProcess["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly worktreesDir: string;
  readonly bookmarkTo: JjRemoteOps["bookmarkTo"];
}

export type JjWorkspaceOps = Pick<
  VcsWorkflowOps,
  "createWorktree" | "removeWorktree" | "pruneWorktrees"
>;

export const makeJjWorkspaces = (deps: JjWorkspaceOpsDeps): JjWorkspaceOps => {
  const { bookmarkTo, driver, fileSystem, path, process, worktreesDir } = deps;

  const run = JjProcess.jjRunner(process);
  // Serialize each repository's adds and rollback without blocking unrelated repositories.
  const createLocks = Effect.runSync(KeyedLock.make<string>());

  const canonicalize = (value: string) =>
    Effect.gen(function* () {
      let ancestor = path.resolve(value);
      const suffix: string[] = [];
      while (true) {
        const resolved = yield* fileSystem.realPath(ancestor).pipe(Effect.option);
        if (Option.isSome(resolved)) return path.join(resolved.value, ...suffix);
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return value;
        suffix.unshift(path.basename(ancestor));
        ancestor = parent;
      }
    });

  const isJjWorkspaceDirectory = (candidate: string) =>
    fileSystem.exists(path.join(candidate, ".jj")).pipe(Effect.orElseSucceed(() => false));

  const forgetWorkspace = (operation: string, cwd: string, name: string) =>
    run(operation, cwd, ["workspace", "forget", name], {
      allowNonZeroExit: true,
      timeoutMs: 30_000,
    });

  const pruneGitWorktrees = (operation: string, gitDir: string, cwd: string) =>
    JjProcess.colocatedGitCommand(
      process,
      operation,
      { gitDir, workTree: cwd, cwd },
      ["worktree", "prune"],
      { allowNonZeroExit: true, timeoutMs: 15_000 },
    ).pipe(Effect.ignore);

  const removeIfOnlyJjMetadata = (directory: string) =>
    Effect.gen(function* () {
      const entries = yield* fileSystem
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      if (entries.length === 0 || (entries.length === 1 && entries[0] === ".jj")) {
        yield* fileSystem.remove(directory, { recursive: true }).pipe(Effect.ignore);
      }
    });

  const createWorkspace = Effect.fn("JjWorkspaces.createWorkspace")(function* (
    paths: JjRepoPaths & { readonly gitDir: string },
    input: Parameters<JjWorkspaceOps["createWorktree"]>[0],
    options?: Parameters<JjWorkspaceOps["createWorktree"]>[1],
  ) {
    const operation = "JjWorkspaces.createWorktree";

    const remoteNames = yield* driver
      .listRemoteNames(input.cwd)
      .pipe(mapJjFailure(operation, input.cwd, "Could not read this repository's remotes."));
    // Resolve the selected base before tracking can create a same-named local bookmark.
    // Launch may pass a commit as refName while retaining the selected ref in baseRefName.
    let baseRefNameForConfig: string | undefined;
    let comparisonRef: string | undefined;
    if (input.newRefName !== undefined && input.baseRefName !== undefined) {
      let fullRef: string | undefined;
      if (input.baseRefName.startsWith("refs/remotes/")) {
        fullRef = input.baseRefName;
      } else {
        const resolved = yield* JjProcess.colocatedGitCommand(
          process,
          operation,
          { gitDir: paths.gitDir, cwd: input.cwd },
          [
            "rev-parse",
            "--symbolic-full-name",
            "--verify",
            "--end-of-options",
            input.baseRefName,
          ],
          { allowNonZeroExit: true, timeoutMs: 10_000 },
        ).pipe(mapJjFailure(operation, input.cwd, "Could not resolve the selected base ref."));
        if (resolved.exitCode === 0) {
          fullRef = resolved.stdout.trim();
        } else {
          const primaryRemote = yield* driver
            .resolvePrimaryRemoteName(input.cwd)
            .pipe(mapJjFailure(operation, input.cwd, "Could not resolve the primary remote."));
          const bookmarks = yield* driver
            .listBookmarks(input.cwd)
            .pipe(mapJjFailure(operation, input.cwd, "Could not list Jujutsu bookmarks."));
          if (
            primaryRemote !== null &&
            bookmarks.some(
              (bookmark) =>
                bookmark.remote === primaryRemote && bookmark.name === input.baseRefName,
            )
          ) {
            fullRef = `refs/remotes/${primaryRemote}/${input.baseRefName}`;
          }
        }
      }
      if (fullRef?.startsWith("refs/heads/")) {
        baseRefNameForConfig = fullRef.slice("refs/heads/".length);
      } else if (fullRef?.startsWith("refs/remotes/")) {
        const remote = splitRemoteRefName(fullRef.slice("refs/remotes/".length), remoteNames);
        if (remote !== null) {
          baseRefNameForConfig = remote.name;
          comparisonRef = fullRef;
        }
      }
    }
    const remoteBase = splitRemoteRefName(input.refName, remoteNames);
    if (remoteBase !== null) {
      // Tracked whenever a remote base is named, not only alongside `newRefName`: otherwise
      // `jj workspace add -r bookmarks(exact:"origin/featX")` registers a workspace and then
      // fails on an empty revision set, leaving a half-created directory behind.
      yield* trackRemoteBookmark({
        process,
        operation,
        cwd: input.cwd,
        gitDir: paths.gitDir,
        remoteName: remoteBase.remote,
        name: remoteBase.name,
      });
    }
    const baseRef = remoteBase?.name ?? input.refName;
    const targetRef = input.newRefName ?? baseRef;
    const workspaceName = workspaceNameForRef(targetRef);

    const workspaces = yield* driver
      .listWorkspaces(input.cwd)
      .pipe(mapJjFailure(operation, input.cwd, "Could not list Jujutsu workspaces."));
    const existing = workspaces.find((workspace) => workspace.name === workspaceName);

    if (existing !== undefined) {
      const existingRoot = existing.root;
      const healthy =
        (yield* fileSystem.exists(existingRoot).pipe(Effect.orElseSucceed(() => false))) &&
        (yield* isJjWorkspaceDirectory(existingRoot));
      if (healthy) {
        if (input.newRefName !== undefined) {
          return yield* Effect.fail(
            jjFailure(operation, input.cwd, `Bookmark ${targetRef} already has a workspace.`),
          );
        }
        return {
          worktree: { path: existingRoot, refName: targetRef },
          newlyCreated: false as const,
        };
      }
      // A registered workspace whose directory is gone, or that holds no `.jj`, is the
      // half-created state a failed `jj workspace add` leaves behind.
      yield* forgetWorkspace(operation, paths.mainWorkspaceRoot, workspaceName).pipe(Effect.ignore);
      yield* removeIfOnlyJjMetadata(existingRoot);
      // Forget cannot remove Git's registration when the directory was already deleted.
      yield* pruneGitWorktrees(operation, paths.gitDir, paths.mainWorkspaceRoot);
    }

    const requestedPath =
      input.path ??
      defaultWorkspacePathForRef({
        worktreesDir: options?.worktreesDirectory ?? worktreesDir,
        mainWorkspaceRoot: paths.mainWorkspaceRoot,
        refName: targetRef,
      });
    const resolvedRequestedPath = yield* canonicalize(requestedPath);
    const takenByAnotherWorkspace = workspaces.some(
      (workspace) => workspace.name !== workspaceName && workspace.root === resolvedRequestedPath,
    );
    const worktreePath = takenByAnotherWorkspace
      ? `${requestedPath}-${bookmarkDigest(targetRef)}`
      : requestedPath;

    const destinationExisted = yield* fileSystem
      .exists(worktreePath)
      .pipe(Effect.orElseSucceed(() => false));
    if (destinationExisted) {
      const entries = yield* fileSystem
        .readDirectory(worktreePath)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      if (entries.length > 0) {
        return yield* Effect.fail(
          jjFailure(
            operation,
            input.cwd,
            `${worktreePath} already exists and is not a Jujutsu workspace.`,
          ),
        );
      }
    }

    yield* assertBookmarkUsable(driver, operation, input.cwd, targetRef);
    let baseRevset = refNameToRevset(baseRef, remoteNames);
    const bookmarks = yield* driver
      .listBookmarks(input.cwd)
      .pipe(mapJjFailure(operation, input.cwd, "Could not list Jujutsu bookmarks."));
    if (
      paths.gitDir !== null &&
      !bookmarks.some((bookmark) => bookmark.remote === null && bookmark.name === baseRef)
    ) {
      const resolved = yield* JjProcess.colocatedGitCommand(
        process,
        operation,
        { gitDir: paths.gitDir, workTree: input.cwd, cwd: input.cwd },
        [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${baseRef === "-" ? "@{-1}" : baseRef}^{commit}`,
        ],
        { allowNonZeroExit: true, timeoutMs: 10_000 },
      ).pipe(mapJjFailure(operation, input.cwd, `Could not resolve base ${baseRef}.`));
      if (resolved.exitCode === 0) {
        baseRevset = resolved.stdout.trim();
      }
    }
    const rollbackBookmark = () =>
      input.newRefName === undefined
        ? Effect.void
        : run(
            operation,
            input.cwd,
            ["bookmark", "delete", bookmarkNameArgument(input.newRefName)],
            {
              allowNonZeroExit: true,
              timeoutMs: 20_000,
            },
          ).pipe(Effect.ignore);
    yield* Effect.acquireUseRelease(
      input.newRefName === undefined
        ? Effect.succeed(false)
        : run(
            operation,
            input.cwd,
            ["bookmark", "create", bookmarkNameArgument(input.newRefName), "-r", baseRevset],
            { timeoutMs: 20_000 },
          ).pipe(
            mapJjFailure(operation, input.cwd, `Could not create bookmark ${input.newRefName}.`),
            Effect.as(true),
          ),
      () =>
        Effect.gen(function* () {
          // jj creates only the leaf directory; a missing parent fails with "Cannot access ...".
          yield* fileSystem
            .makeDirectory(path.dirname(worktreePath), { recursive: true })
            .pipe(
              mapJjFailure(operation, input.cwd, `Could not create ${path.dirname(worktreePath)}.`),
            );

          // `-r X` means "@ is a fresh empty child of X". The bookmark stays on X and the thread's
          // edits land in `@`, which is git's `worktree add -b new base` translated.
          yield* run(
            operation,
            input.cwd,
            [
              "workspace",
              "add",
              // Git-dependent tooling and submodule initialization require a colocated child.
              "--colocate",
              "--name",
              workspaceName,
              "-r",
              input.newRefName === undefined ? baseRevset : refNameToRevset(targetRef, remoteNames),
              worktreePath,
            ],
            { timeoutMs: WORKSPACE_ADD_TIMEOUT_MS },
          ).pipe(
            mapJjFailure(operation, input.cwd, `Could not create a workspace at ${worktreePath}.`),
            // jj can register the workspace and then fail, and a retry on a registered name fails
            // with "Workspace named '<name>' already exists".
            Effect.onError(() =>
              forgetWorkspace(operation, paths.mainWorkspaceRoot, workspaceName).pipe(
                Effect.ignore,
                Effect.andThen(
                  destinationExisted
                    ? Effect.void
                    : fileSystem.remove(worktreePath, { recursive: true }).pipe(Effect.ignore),
                ),
              ),
            ),
          );
        }),
      (createdBookmark, exit) =>
        createdBookmark && Exit.isFailure(exit) ? rollbackBookmark() : Effect.void,
    );

    // gh consumes a provider branch name; T3 retains the full selected remote for comparison.
    return {
      worktree: { path: worktreePath, refName: targetRef },
      newlyCreated: true as const,
      gitConfig: {
        process,
        gitDir: paths.gitDir,
        cwd: input.cwd,
        targetRef,
        ...(remoteBase !== null ? { upstreamRemoteName: remoteBase.remote } : {}),
        ...(input.newRefName !== undefined ? { newRefName: input.newRefName } : {}),
        ...(baseRefNameForConfig !== undefined ? { baseRefName: baseRefNameForConfig } : {}),
        ...(comparisonRef !== undefined ? { comparisonRef } : {}),
      },
    };
  });

  const createWorktree: JjWorkspaceOps["createWorktree"] = Effect.fn("JjWorkspaces.createWorktree")(
    function* (input, options) {
      const operation = "JjWorkspaces.createWorktree";
      const paths = yield* driver
        .ensureUsable(operation, input.cwd)
        .pipe(mapJjFailure(operation, input.cwd, "This Jujutsu repository cannot be used."));
      const created = yield* createLocks.withLock(
        paths.mainWorkspaceRoot,
        createWorkspace(paths, input, options),
      );
      yield* driver.invalidateRepoCaches(paths.mainWorkspaceRoot);
      if (!created.newlyCreated) return { worktree: created.worktree };
      const worktreePath = created.worktree.path;
      const progress = options?.progress;
      if (progress?.onWorktreeClaimed) {
        yield* progress.onWorktreeClaimed(worktreePath);
      }
      yield* createLocks.withLock(
        paths.mainWorkspaceRoot,
        writeWorktreeGitConfig(created.gitConfig),
      );
      const hasSubmodules = yield* fileSystem
        .exists(path.join(worktreePath, ".gitmodules"))
        .pipe(Effect.orElseSucceed(() => false));
      if (hasSubmodules) {
        const projectFile =
          options?.submodules != null
            ? null
            : yield* fileSystem.readFileString(path.join(worktreePath, T3_PROJECT_FILE_NAME)).pipe(
                Effect.flatMap((contents) => {
                  const parsed = parseT3ProjectFile(contents);
                  return parsed === null
                    ? Effect.logWarning("t3.json is invalid; initializing submodules recursively", {
                        worktreePath,
                      }).pipe(Effect.as(null))
                    : Effect.succeed(parsed);
                }),
                Effect.orElseSucceed(() => null),
              );
        const mode = resolveProjectFileBackedSetting(
          "worktreeSubmodules",
          options?.submodules ?? null,
          projectFile,
        );
        if (mode.value === "none") {
          if (progress?.onSubmodulesDisabled) {
            yield* progress.onSubmodulesDisabled({
              source: mode.source === "t3.json" ? "t3.json" : "settings",
            });
          }
        } else {
          if (progress?.onSubmodulesStarted) {
            yield* progress.onSubmodulesStarted();
          }
          yield* process
            .run({
              operation: `${operation}.updateSubmodules`,
              command: "git",
              cwd: worktreePath,
              args: [
                "submodule",
                "update",
                "--init",
                ...(mode.value === "recursive" ? ["--recursive"] : []),
              ],
              env: { LC_ALL: "C" },
              allowNonZeroExit: true,
              timeoutMs: WORKSPACE_ADD_TIMEOUT_MS,
            })
            .pipe(
              Effect.flatMap((result) =>
                Effect.gen(function* () {
                  // VcsProcess buffers stderr, where Git writes submodule progress.
                  if (progress?.onSubmoduleLine) {
                    for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
                      if (line.length > 0) yield* progress.onSubmoduleLine(line);
                    }
                  }
                  if (result.exitCode !== 0) {
                    return yield* Effect.fail(
                      jjFailure(operation, worktreePath, result.stderr.trim()),
                    );
                  }
                }),
              ),
              Effect.matchEffect({
                onFailure: (cause) =>
                  Effect.logWarning(
                    "worktree submodule checkout failed; submodule paths are empty",
                    {
                      worktreePath,
                      cause,
                    },
                  ).pipe(
                    Effect.andThen(
                      progress?.onSubmodulesFinished
                        ? progress.onSubmodulesFinished({ ok: false, detail: cause.message })
                        : Effect.void,
                    ),
                  ),
                onSuccess: () =>
                  progress?.onSubmodulesFinished
                    ? progress.onSubmodulesFinished({ ok: true, detail: null })
                    : Effect.void,
              }),
            );
        }
      }
      return { worktree: created.worktree };
    },
  );

  const removeWorktree: JjWorkspaceOps["removeWorktree"] = Effect.fn("JjWorkspaces.removeWorktree")(
    function* (input) {
      const operation = "JjWorkspaces.removeWorktree";
      const paths = yield* driver
        .ensureUsable(operation, input.cwd)
        .pipe(mapJjFailure(operation, input.cwd, "This Jujutsu repository cannot be used."));
      const workspaces = yield* driver
        .listWorkspaces(input.cwd)
        .pipe(mapJjFailure(operation, input.cwd, "Could not list Jujutsu workspaces."));

      const target = yield* canonicalize(input.path);
      const matched = workspaces.find((workspace) => workspace.root === target);

      if (matched === undefined) {
        const directoryExists = yield* fileSystem
          .exists(input.path)
          .pipe(mapJjFailure(operation, input.cwd, `Could not inspect ${input.path}.`));
        if (!directoryExists) {
          yield* pruneGitWorktrees(operation, paths.gitDir, paths.mainWorkspaceRoot);
          return;
        }
        return yield* Effect.fail(
          jjFailure(operation, input.cwd, `No Jujutsu workspace is registered at ${input.path}.`),
        );
      }
      if (matched.name === "default" || matched.root === paths.mainWorkspaceRoot) {
        // Keep the main-workspace guard before any bookmark movement or filesystem mutation.
        return yield* Effect.fail(
          jjFailure(
            operation,
            input.cwd,
            `${input.path} is the main Jujutsu workspace and cannot be removed.`,
          ),
        );
      }

      const directoryExists = yield* fileSystem
        .exists(matched.root)
        .pipe(Effect.orElseSucceed(() => false));
      if (!directoryExists) {
        yield* forgetWorkspace(operation, paths.mainWorkspaceRoot, matched.name).pipe(
          Effect.ignore,
        );
        yield* driver.invalidateRepoCaches(paths.mainWorkspaceRoot);
        yield* pruneGitWorktrees(operation, paths.gitDir, paths.mainWorkspaceRoot);
        return;
      }

      // `currentChange`, not `changeAt`: `changeAt` always passes `--ignore-working-copy` and so
      // reports the last snapshot, under which an agent that just wrote files reads as empty.
      const change = yield* driver.currentChange(input.path).pipe(Effect.option);
      const segment = yield* driver
        .currentSegment(input.path)
        .pipe(mapJjFailure(operation, input.path, "Could not read the workspace segment."));
      const stranded = strandedSegmentRows(segment).length > 0;
      // An unreadable workspace is not a licence to delete it.
      const dirty = Option.isNone(change) || !change.value.empty || stranded;

      if (dirty && input.force !== true) {
        return yield* Effect.fail(
          jjFailure(
            operation,
            input.cwd,
            "Workspace has uncommitted or unbookmarked changes. Force removal deletes the workspace directory. Only snapshotted Jujutsu changes are retained; ignored files and files excluded by snapshot size limits may be lost.",
          ),
        );
      }

      const segmentBookmark = yield* resolveWorkspaceRefName(driver, input.path, segment).pipe(
        mapJjFailure(operation, input.path, "Could not resolve the workspace bookmark."),
      );
      if (stranded && segmentBookmark !== null) {
        // `jj workspace add -r <bookmark>` leaves the bookmark on the base, so the agent's own
        // commits sit on no ref. Moving the bookmark to `@-` first is the jj spelling of what
        // git's worktree branch does for free; a failure here must not block the removal.
        yield* bookmarkTo({
          cwd: input.path,
          name: segmentBookmark,
          revset: "@-",
          operation,
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("could not move the workspace bookmark before removing it", {
              worktreePath: input.path,
              bookmark: segmentBookmark,
              cause,
            }),
          ),
        );
      }

      yield* run(operation, paths.mainWorkspaceRoot, ["workspace", "remove", matched.name], {
        timeoutMs: WORKSPACE_ADD_TIMEOUT_MS,
      }).pipe(mapJjFailure(operation, input.cwd, `Could not remove workspace ${matched.name}.`));
      yield* driver.invalidateRepoCaches(paths.mainWorkspaceRoot);
    },
  );

  const pruneWorktrees: JjWorkspaceOps["pruneWorktrees"] = Effect.fn("JjWorkspaces.pruneWorktrees")(
    function* (input) {
      const operation = "JjWorkspaces.pruneWorktrees";
      const paths = yield* driver
        .ensureUsable(operation, input.cwd)
        .pipe(mapJjFailure(operation, input.cwd, "This Jujutsu repository cannot be used."));
      const workspaces = yield* driver
        .listWorkspaces(input.cwd)
        .pipe(mapJjFailure(operation, input.cwd, "Could not list Jujutsu workspaces."));

      for (const workspace of workspaces) {
        // The name filter keeps a user's own workspace on an unmounted volume registered; only
        // directories T3 created are reclaimed. `default` can never match.
        if (!isT3WorkspaceName(workspace.name)) {
          continue;
        }
        const present = yield* fileSystem
          .exists(workspace.root)
          .pipe(Effect.orElseSucceed(() => false));
        if (present) {
          continue;
        }
        yield* forgetWorkspace(operation, paths.mainWorkspaceRoot, workspace.name).pipe(
          Effect.ignore,
        );
        yield* driver.invalidateRepoCaches(paths.mainWorkspaceRoot);
      }

      // A colocated repository can hold `git worktree` admin entries created before jj detection
      // was enabled, and nothing else reclaims them once the project routes to the jj arm.
      yield* pruneGitWorktrees(operation, paths.gitDir, paths.mainWorkspaceRoot);
    },
  );

  return { createWorktree, removeWorktree, pruneWorktrees };
};

/**
 * The per-thread PR base and upstream, written where git records them. A jj bookmark is
 * `refs/heads/<name>` in the colocated store, so the whole git-side PR machinery reads these back.
 * The upstream keys go on the thread's own bookmark, not on the base it was cut from: they are what
 * `resolveBranchHeadContext` reads to decide whether a pull request head is cross-repository.
 */
const writeWorktreeGitConfig = Effect.fn("JjWorkspaces.writeWorktreeGitConfig")(function* (input: {
  readonly process: VcsProcess.VcsProcess["Service"];
  readonly gitDir: string | null;
  readonly cwd: string;
  readonly targetRef: string;
  readonly upstreamRemoteName?: string;
  readonly newRefName?: string;
  readonly baseRefName?: string;
  readonly comparisonRef?: string;
}): Effect.fn.Return<void, never> {
  const gitDir = input.gitDir;
  if (gitDir === null) {
    return;
  }
  if (input.upstreamRemoteName !== undefined) {
    yield* writeBookmarkUpstreamConfig(input.process, {
      gitDir,
      cwd: input.cwd,
      name: input.targetRef,
      remoteName: input.upstreamRemoteName,
    });
  }
  if (input.newRefName === undefined || input.baseRefName === undefined) {
    return;
  }
  yield* JjProcess.colocatedGitCommand(
    input.process,
    "JjWorkspaces.writeWorktreeGitConfig",
    { gitDir, cwd: input.cwd },
    ["config", `branch.${input.newRefName}.gh-merge-base`, input.baseRefName],
    { allowNonZeroExit: true, timeoutMs: 10_000 },
  ).pipe(Effect.ignore);
  if (input.comparisonRef !== undefined) {
    yield* JjProcess.colocatedGitCommand(
      input.process,
      "JjWorkspaces.writeWorktreeGitConfig",
      { gitDir, cwd: input.cwd },
      ["config", `branch.${input.newRefName}.t3-merge-base-ref`, input.comparisonRef],
      { allowNonZeroExit: true, timeoutMs: 10_000 },
    ).pipe(Effect.ignore);
  }
});
