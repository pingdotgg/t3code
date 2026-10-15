/**
 * WorkspaceWorktrees - isolated checkouts for multi-repo workspaces.
 *
 * An isolated run in a multi-repo project gets a container folder that mirrors the project:
 * one Git worktree per repository at the same relative path, all on the thread's branch, plus
 * links to the project's other top-level files and folders, so shared instructions and editor
 * settings resolve the way they do in the project. The thread records the container as its
 * worktree path, so everything that works on one folder keeps working, and per-repository Git
 * work joins a repository's relative path onto it.
 *
 * @module WorkspaceWorktrees
 */
import { GitCommandError, type VcsRepository } from "@t3tools/contracts";
import {
  flattenTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  WORKTREE_BRANCH_PREFIX,
} from "@t3tools/shared/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as WorkspaceRepositories from "../workspace/WorkspaceRepositories.ts";

export interface CreateWorkspaceWorktreeInput {
  readonly workspaceRoot: string;
  readonly repositories: ReadonlyArray<VcsRepository>;
  readonly branch: string;
  /** Fetch each repository's default branch and start from the remote's copy. */
  readonly startFromOrigin: boolean;
}

export class WorkspaceWorktrees extends Context.Service<
  WorkspaceWorktrees,
  {
    /**
     * Create a container with a worktree per repository, each started from its repository's
     * default branch. The container is reported as soon as it exists so a caller can remove a
     * partial one with `remove` if a later repository fails.
     */
    readonly create: (
      input: CreateWorkspaceWorktreeInput,
      options?: { readonly onContainerClaimed?: (path: string) => Effect.Effect<void> },
    ) => Effect.Effect<{ readonly path: string; readonly branch: string }, GitCommandError>;
    /** Rename the branch in every repository; the first repository decides the final name. */
    readonly renameBranch: (input: {
      readonly path: string;
      readonly oldBranch: string;
      readonly newBranch: string;
      readonly exactName?: boolean;
    }) => Effect.Effect<{ readonly branch: string }, GitCommandError>;
    /** Whether `path` is a container this service created. */
    readonly isContainer: (path: string) => Effect.Effect<boolean>;
    /**
     * Remove every repository's worktree, then the links and folders the container added.
     * Anything else left in the container is kept for the user.
     */
    readonly remove: (input: {
      readonly workspaceRoot: string;
      readonly path: string;
      readonly force: boolean;
    }) => Effect.Effect<void, GitCommandError>;
  }
>()("t3/git/WorkspaceWorktrees") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const workspaceRepositories = yield* WorkspaceRepositories.WorkspaceRepositories;

  const fail = (operation: string, cwd: string, detail: string, cause?: unknown) =>
    new GitCommandError({ operation, command: "worktree", cwd, detail, cause });

  const join = (root: string, relativePath: string) => path.join(root, ...relativePath.split("/"));

  const isInsideWorktreesDir = (target: string) => {
    const relative = path.relative(config.worktreesDir, target);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  };

  const hasCommit = (cwd: string, refName: string) =>
    git
      .execute({
        operation: "WorkspaceWorktrees.hasCommit",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", `${refName}^{commit}`],
        allowNonZeroExit: true,
      })
      .pipe(Effect.map((result) => result.exitCode === 0));

  // The repository's default branch (from its primary remote), or its current checkout.
  const resolveStart = Effect.fn("WorkspaceWorktrees.resolveStart")(function* (
    cwd: string,
    startFromOrigin: boolean,
  ) {
    const remote = yield* git.resolvePrimaryRemoteName(cwd).pipe(Effect.option);
    const defaultBranch =
      remote._tag === "None"
        ? null
        : yield* git
            .resolveDefaultBranchName(cwd, remote.value)
            .pipe(Effect.orElseSucceed(() => null));
    if (remote._tag === "Some" && defaultBranch !== null && startFromOrigin) {
      yield* git.fetchRemote({ cwd, remoteName: remote.value, refName: defaultBranch });
      if (
        yield* git.remoteBranchExists({ cwd, remoteName: remote.value, refName: defaultBranch })
      ) {
        const tracking = yield* git.resolveRemoteTrackingCommit({
          cwd,
          refName: defaultBranch,
          fallbackRemoteName: remote.value,
        });
        return { startRef: tracking.commitSha, baseRef: defaultBranch };
      }
    }
    if (defaultBranch !== null && (yield* hasCommit(cwd, defaultBranch))) {
      return { startRef: defaultBranch, baseRef: defaultBranch };
    }
    return { startRef: "HEAD", baseRef: "HEAD" };
  });

  // Links are a convenience, so a platform that refuses one only loses that entry. A
  // `.code-workspace` file defines which folders belong to the workspace, so with one only its
  // listed folders are linked, along with top-level files and dot-folders, which usually hold
  // workspace-wide configuration. Without one, every top-level entry is linked.
  const linkSharedEntries = Effect.fn("WorkspaceWorktrees.linkSharedEntries")(function* (
    workspaceRoot: string,
    container: string,
  ) {
    const layout = yield* workspaceRepositories.describe(workspaceRoot);
    const repositoryFolders = new Set(
      layout.repositories.map((repository) => repository.relativePath.split("/")[0]),
    );
    const listedFolders =
      layout.listedFolders === null
        ? null
        : new Set(layout.listedFolders.map((folder) => folder.split("/")[0]));
    const names = yield* fileSystem
      .readDirectory(workspaceRoot)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const name of names) {
      if (repositoryFolders.has(name)) continue;
      const target = path.join(workspaceRoot, name);
      if (listedFolders !== null && !name.startsWith(".") && !listedFolders.has(name)) {
        const isDirectory = yield* fileSystem.stat(target).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        );
        if (isDirectory) continue;
      }
      yield* fileSystem.symlink(target, path.join(container, name)).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not link a workspace entry into an isolated run", {
            container,
            name,
            cause,
          }),
        ),
      );
    }
  });

  const create: WorkspaceWorktrees["Service"]["create"] = Effect.fn("WorkspaceWorktrees.create")(
    function* (input, options) {
      const operation = "WorkspaceWorktrees.create";
      // A plain `t3` branch in any repository blocks `t3/*`, so all of them use `t3-<hash>`.
      let branch = input.branch;
      if (isTemporaryWorktreeBranch(branch)) {
        for (const repository of input.repositories) {
          const cwd = join(input.workspaceRoot, repository.relativePath);
          if (yield* hasCommit(cwd, `refs/heads/${WORKTREE_BRANCH_PREFIX}`)) {
            branch = flattenTemporaryWorktreeBranchName(branch);
            break;
          }
        }
      }
      const container = path.join(
        config.worktreesDir,
        path.basename(input.workspaceRoot),
        branch.replace(/\//g, "-"),
      );
      if (yield* fileSystem.exists(container).pipe(Effect.orElseSucceed(() => true))) {
        return yield* fail(operation, input.workspaceRoot, `${container} already exists.`);
      }
      yield* fileSystem
        .makeDirectory(container, { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            fail(operation, input.workspaceRoot, `Could not create ${container}.`, cause),
          ),
        );
      if (options?.onContainerClaimed) yield* options.onContainerClaimed(container);
      // Link first: a `.code-workspace` link tells `remove` which folders to clean up if a
      // repository below fails.
      yield* linkSharedEntries(input.workspaceRoot, container);
      for (const repository of input.repositories) {
        const repositoryCwd = join(input.workspaceRoot, repository.relativePath);
        const worktreePath = join(container, repository.relativePath);
        yield* fileSystem
          .makeDirectory(path.dirname(worktreePath), { recursive: true })
          .pipe(
            Effect.mapError((cause) =>
              fail(operation, repositoryCwd, `Could not create ${worktreePath}.`, cause),
            ),
          );
        const start = yield* resolveStart(repositoryCwd, input.startFromOrigin);
        yield* git.createWorktree({
          cwd: repositoryCwd,
          refName: start.startRef,
          newRefName: branch,
          baseRefName: start.baseRef,
          path: worktreePath,
        });
      }
      return { path: container, branch };
    },
  );

  const renameBranch: WorkspaceWorktrees["Service"]["renameBranch"] = Effect.fn(
    "WorkspaceWorktrees.renameBranch",
  )(function* (input) {
    const [first, ...rest] = yield* workspaceRepositories.list(input.path);
    if (first === undefined) {
      return yield* fail(
        "WorkspaceWorktrees.renameBranch",
        input.path,
        "The isolated run holds no repositories.",
      );
    }
    const renamed = yield* git.renameBranch({
      cwd: join(input.path, first.relativePath),
      oldBranch: input.oldBranch,
      newBranch: input.newBranch,
      ...(input.exactName ? { exactName: true } : {}),
    });
    for (const [index, repository] of rest.entries()) {
      yield* git
        .renameBranch({
          cwd: join(input.path, repository.relativePath),
          oldBranch: input.oldBranch,
          newBranch: renamed.branch,
          exactName: true,
        })
        .pipe(
          // Put the renamed repositories back so every repository stays on one branch.
          Effect.tapError(() =>
            Effect.forEach([first, ...rest.slice(0, index)], (done) =>
              git
                .renameBranch({
                  cwd: join(input.path, done.relativePath),
                  oldBranch: renamed.branch,
                  newBranch: input.oldBranch,
                  exactName: true,
                })
                .pipe(Effect.ignore({ log: true })),
            ),
          ),
        );
    }
    return { branch: renamed.branch };
  });

  const hasGitEntry = (directory: string) =>
    fileSystem.exists(path.join(directory, ".git")).pipe(Effect.orElseSucceed(() => false));
  const isLink = (target: string) =>
    fileSystem.readLink(target).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  // A single-repository worktree has a `.git` entry at its root; a container never does.
  const isContainer: WorkspaceWorktrees["Service"]["isContainer"] = (target) =>
    isInsideWorktreesDir(target)
      ? fileSystem.stat(target).pipe(
          Effect.flatMap((info) =>
            info.type === "Directory"
              ? hasGitEntry(target).pipe(Effect.map((found) => !found))
              : Effect.succeed(false),
          ),
          Effect.orElseSucceed(() => false),
        )
      : Effect.succeed(false);

  // The container's worktrees, found in the container itself so removal doesn't depend on
  // project files that may have changed since the run was created.
  const findWorktrees = (
    directory: string,
    relativePath = "",
  ): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> =>
    Effect.gen(function* () {
      const found: Array<string> = [];
      for (const name of yield* fileSystem.readDirectory(directory)) {
        const entry = path.join(directory, name);
        if ((yield* isLink(entry)) || (yield* fileSystem.stat(entry)).type !== "Directory") {
          continue;
        }
        const child = relativePath === "" ? name : `${relativePath}/${name}`;
        found.push(...((yield* hasGitEntry(entry)) ? [child] : yield* findWorktrees(entry, child)));
      }
      return found;
    });

  // Removes links and the folders nested repositories needed, bottom-up, keeping real files.
  const removeLeftovers = (
    directory: string,
  ): Effect.Effect<boolean, PlatformError.PlatformError> =>
    Effect.gen(function* () {
      for (const name of yield* fileSystem.readDirectory(directory)) {
        const entry = path.join(directory, name);
        if (yield* isLink(entry)) {
          yield* fileSystem.remove(entry);
        } else if ((yield* fileSystem.stat(entry)).type === "Directory") {
          yield* removeLeftovers(entry);
        }
      }
      if ((yield* fileSystem.readDirectory(directory)).length > 0) return false;
      yield* fileSystem.remove(directory, { recursive: true });
      return true;
    });

  const remove: WorkspaceWorktrees["Service"]["remove"] = Effect.fn("WorkspaceWorktrees.remove")(
    function* (input) {
      const operation = "WorkspaceWorktrees.remove";
      if (!isInsideWorktreesDir(input.path)) {
        return yield* fail(operation, input.path, "Not an isolated run folder.");
      }
      const worktrees = yield* findWorktrees(input.path).pipe(
        Effect.mapError((cause) =>
          fail(operation, input.path, "Could not read the isolated run folder.", cause),
        ),
      );
      for (const relativePath of worktrees) {
        yield* git.removeWorktree({
          cwd: join(input.workspaceRoot, relativePath),
          path: join(input.path, relativePath),
          force: input.force,
        });
      }
      yield* removeLeftovers(input.path).pipe(
        Effect.mapError((cause) =>
          fail(operation, input.path, "Could not remove the isolated run folder.", cause),
        ),
      );
    },
  );

  return WorkspaceWorktrees.of({ create, renameBranch, isContainer, remove });
});

export const layer = Layer.effect(WorkspaceWorktrees, make).pipe(
  Layer.provide(WorkspaceRepositories.layer),
);
