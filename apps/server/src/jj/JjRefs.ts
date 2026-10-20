import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { GitCommandError, VcsRef } from "@t3tools/contracts";
import { dedupeRemoteBranchesWithLocalMatches } from "@t3tools/shared/git";

import type { VcsWorkflowOps } from "../git/GitWorkflowService.ts";
import { filterBranchesForListQuery, paginateBranches } from "../vcs/GitVcsDriverCore.ts";
import * as JjProcess from "../vcs/JjProcess.ts";
import {
  bookmarkNameArgument,
  exactStringPattern,
  localBookmarkRevset,
  splitRemoteRefName,
} from "../vcs/JjRevset.ts";
import type { JjBookmark, JjVcsDriverShape, JjWorkspace } from "../vcs/JjVcsDriver.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";
import { jjFailure, mapJjFailure } from "./JjFailure.ts";
import { assertBookmarkUsable, trackRemoteBookmark } from "./JjRemotes.ts";
import { resolveWorkspaceRefName, strandedSegmentRows } from "./JjStatus.ts";
import { workspaceNameForRef } from "./JjWorkspaces.ts";

const LIST_REFS_SNAPSHOT_CACHE_CAPACITY = 64;
const LIST_REFS_SNAPSHOT_CACHE_TTL = Duration.minutes(2);

interface JjRefsSnapshot {
  readonly bookmarks: ReadonlyArray<JjBookmark>;
  readonly workspaces: ReadonlyArray<JjWorkspace>;
  readonly hasPrimaryRemote: boolean;
  readonly defaultBookmark: string | null;
}

export interface JjRefsDeps {
  readonly driver: JjVcsDriverShape;
  readonly process: VcsProcess.VcsProcess["Service"];
}

export type JjRefsOps = Pick<
  VcsWorkflowOps,
  | "hasRefNamed"
  | "listRefs"
  | "createRef"
  | "switchRef"
  | "listLocalBranchNames"
  | "deleteLocalBranch"
> & {
  readonly renameBranch: (input: {
    readonly cwd: string;
    readonly oldBranch: string;
    readonly exactName?: boolean;
    readonly newBranch: string;
  }) => Effect.Effect<{ readonly branch: string }, GitCommandError>;
  readonly resolveRefName: (
    cwd: string,
    refName: string,
  ) => Effect.Effect<string | null, GitCommandError>;
  /** Refuses when the segment holds work no bookmark protects. Shared with the PR-thread path. */
  readonly assertNoStrandedWork: (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly targetRefName: string;
  }) => Effect.Effect<void, GitCommandError>;
};

export const makeJjRefs = (
  deps: JjRefsDeps,
): Effect.Effect<JjRefsOps, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const { driver, process } = deps;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const run = JjProcess.jjRunner(process);

    const readSnapshot = Effect.fn("JjRefs.readSnapshot")(function* (key: string) {
      const mainWorkspaceRoot = key.slice(0, key.indexOf("\0"));
      const [bookmarks, workspaces, remoteNames, defaultBookmark] = yield* Effect.all([
        driver.listBookmarks(mainWorkspaceRoot),
        driver.listWorkspaces(mainWorkspaceRoot),
        driver.listRemoteNames(mainWorkspaceRoot),
        driver.resolveDefaultBookmark(mainWorkspaceRoot),
      ]);
      return {
        bookmarks,
        workspaces,
        hasPrimaryRemote: remoteNames.length > 0,
        defaultBookmark,
      } satisfies JjRefsSnapshot;
    });

    // Repository generation and operation heads cover both external jj and T3 mutations.
    const snapshotCache = yield* Cache.makeWith(readSnapshot, {
      capacity: LIST_REFS_SNAPSHOT_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: () => LIST_REFS_SNAPSHOT_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    });

    const repoPathsFor = (operation: string, cwd: string) =>
      driver
        .ensureUsable(operation, cwd)
        .pipe(mapJjFailure(operation, cwd, "This Jujutsu repository cannot be read."));

    const listRefs: JjRefsOps["listRefs"] = Effect.fn("JjRefs.listRefs")(function* (input) {
      const operation = "JjRefs.listRefs";
      const paths = yield* repoPathsFor(operation, input.cwd);
      const isAtRepositoryRoot = yield* fileSystem.realPath(input.cwd).pipe(
        Effect.map((physicalCwd) => path.relative(paths.workspaceRoot, physicalCwd) === ""),
        Effect.orElseSucceed(() => undefined),
      );
      const key = `${yield* driver.repoMetadataKey(paths)}\0${yield* driver
        .repoOperationKey(paths)
        .pipe(mapJjFailure(operation, input.cwd, "Could not read Jujutsu operation heads."))}`;
      if (input.refresh === true) {
        yield* Cache.invalidate(snapshotCache, key);
      }
      const snapshot = yield* Cache.get(snapshotCache, key).pipe(
        mapJjFailure(operation, input.cwd, "Could not list Jujutsu bookmarks."),
      );
      const segment = yield* driver
        .currentSegment(input.cwd)
        .pipe(mapJjFailure(operation, input.cwd, "Could not read the workspace segment."));
      const currentRefName = yield* resolveWorkspaceRefName(
        driver,
        input.cwd,
        segment,
        snapshot.workspaces,
      ).pipe(mapJjFailure(operation, input.cwd, "Could not resolve the workspace bookmark."));

      const workspaceRootByName = new Map(
        snapshot.workspaces.map((workspace) => [workspace.name, workspace.root] as const),
      );

      const localRefs: ReadonlyArray<VcsRef> = snapshot.bookmarks
        .filter((bookmark) => bookmark.remote === null)
        .toSorted((left, right) => right.targetTimestamp - left.targetTimestamp)
        .map(
          (bookmark) =>
            ({
              name: bookmark.name,
              current: bookmark.name === currentRefName,
              isDefault: bookmark.name === snapshot.defaultBookmark,
              // A workspace jj lists with no root has lost its directory; reporting it would hand
              // the client a path it passes straight back to `removeWorktree`.
              worktreePath: workspaceRootByName.get(workspaceNameForRef(bookmark.name)) ?? null,
            }) satisfies VcsRef,
        );

      const remoteRefs: ReadonlyArray<VcsRef> = snapshot.bookmarks
        .filter((bookmark) => bookmark.remote !== null)
        .toSorted((left, right) => right.targetTimestamp - left.targetTimestamp)
        .map(
          (bookmark) =>
            ({
              name: `${bookmark.remote}/${bookmark.name}`,
              isRemote: true,
              ...(bookmark.remote === null ? {} : { remoteName: bookmark.remote }),
              current: false,
              isDefault: false,
              worktreePath: null,
            }) satisfies VcsRef,
        );

      const combined =
        input.includeMatchingRemoteRefs === true
          ? [...localRefs, ...remoteRefs]
          : dedupeRemoteBranchesWithLocalMatches([...localRefs, ...remoteRefs]);
      // Keep current/default refs on the first page, the way the Git implementation does.
      const allRefs = combined.toSorted((left, right) => {
        const leftPriority = left.current ? 0 : left.isDefault ? 1 : 2;
        const rightPriority = right.current ? 0 : right.isDefault ? 1 : 2;
        return leftPriority - rightPriority;
      });
      const refsForKind =
        input.refKind === "local"
          ? allRefs.filter((ref) => !ref.isRemote)
          : input.refKind === "remote"
            ? allRefs.filter((ref) => ref.isRemote)
            : allRefs;

      const page = paginateBranches({
        refs: filterBranchesForListQuery(refsForKind, input.query),
        cursor: input.cursor,
        limit: input.limit,
      });

      return {
        ...(isAtRepositoryRoot === undefined ? {} : { isAtRepositoryRoot }),
        refs: [...page.refs],
        isRepo: true,
        hasPrimaryRemote: snapshot.hasPrimaryRemote,
        nextCursor: page.nextCursor,
        totalCount: page.totalCount,
      };
    });

    const assertNoStrandedWork: JjRefsOps["assertNoStrandedWork"] = Effect.fn(
      "JjRefs.assertNoStrandedWork",
    )(function* (input) {
      const change = yield* driver
        .currentChange(input.cwd)
        .pipe(mapJjFailure(input.operation, input.cwd, "Could not read the working-copy change."));
      const segment = yield* driver
        .currentSegment(input.cwd)
        .pipe(mapJjFailure(input.operation, input.cwd, "Could not read the workspace segment."));
      const stranded =
        strandedSegmentRows(segment).length > 0 ||
        (segment.length === 0 && !change.empty && change.localBookmarks.length === 0);
      if (stranded) {
        return yield* Effect.fail(
          jjFailure(
            input.operation,
            input.cwd,
            `This work is not on a bookmark yet. Create a bookmark for it (or commit and bookmark it) before switching to ${input.targetRefName}; \`jj new\` would hide it.`,
          ),
        );
      }
    });

    const createRef: JjRefsOps["createRef"] = Effect.fn("JjRefs.createRef")(function* (input) {
      const operation = "JjRefs.createRef";
      yield* repoPathsFor(operation, input.cwd);
      yield* assertBookmarkUsable(driver, operation, input.cwd, input.refName);

      const change = yield* driver
        .currentChange(input.cwd)
        .pipe(mapJjFailure(operation, input.cwd, "Could not read the working-copy change."));
      // A non-empty `@` holds the work the user means to name. An empty `@` holds nothing, and it
      // is exactly the state the agent leaves after `jj commit`, so the bookmark belongs on `@-`,
      // except in a repository with no commits, where `@-` is the root commit and cannot export.
      const target = !change.empty ? "@" : change.parentCommitIds.length > 0 ? "@-" : "@";

      yield* run(
        operation,
        input.cwd,
        ["bookmark", "create", bookmarkNameArgument(input.refName), "-r", target],
        {
          timeoutMs: 20_000,
        },
      ).pipe(mapJjFailure(operation, input.cwd, `Could not create bookmark ${input.refName}.`));
      yield* driver.invalidateRepoCaches(input.cwd);

      // `switchRef` is a no-op after create: naming the current line of work is being on it, and
      // `jj new` would move off the bookmark that was just made.
      return { refName: input.refName };
    });

    const switchRef: JjRefsOps["switchRef"] = Effect.fn("JjRefs.switchRef")(function* (input) {
      const operation = "JjRefs.switchRef";
      const paths = yield* repoPathsFor(operation, input.cwd);
      yield* assertNoStrandedWork({
        cwd: input.cwd,
        operation,
        targetRefName: input.refName,
      });

      const remoteNames = yield* driver
        .listRemoteNames(input.cwd)
        .pipe(mapJjFailure(operation, input.cwd, "Could not read this repository's remotes."));
      const remoteRef = splitRemoteRefName(input.refName, remoteNames);
      const localName = remoteRef?.name ?? input.refName;

      if (remoteRef !== null) {
        yield* trackRemoteBookmark({
          process,
          operation,
          cwd: input.cwd,
          gitDir: paths.gitDir,
          remoteName: remoteRef.remote,
          name: remoteRef.name,
        });
      }
      yield* assertBookmarkUsable(driver, operation, input.cwd, localName);

      // `jj new`, never `jj edit`: editing rewrites a possibly-pushed commit and walks straight
      // into jj's immutability wall.
      yield* run(operation, input.cwd, ["new", localBookmarkRevset(localName)], {
        timeoutMs: 60_000,
      }).pipe(mapJjFailure(operation, input.cwd, `Could not switch to ${localName}.`));
      yield* driver.invalidateRepoCaches(input.cwd);

      return { refName: localName };
    });

    const renameBranch: JjRefsOps["renameBranch"] = Effect.fn("JjRefs.renameBranch")(
      function* (input) {
        if (input.oldBranch === input.newBranch) return { branch: input.newBranch };
        const operation = "JjRefs.renameBranch";
        const paths = yield* repoPathsFor(operation, input.cwd);
        yield* assertBookmarkUsable(driver, operation, input.cwd, input.oldBranch);
        let targetBranch = input.newBranch;
        if (!input.exactName) {
          const bookmarks = yield* driver
            .listBookmarks(input.cwd)
            .pipe(mapJjFailure(operation, input.cwd, "Could not list Jujutsu bookmarks."));
          const names = new Set(
            bookmarks
              .filter((bookmark) => bookmark.remote === null)
              .map((bookmark) => bookmark.name),
          );
          let suffix = 1;
          while (names.has(targetBranch) && suffix <= 100) {
            targetBranch = `${input.newBranch}-${suffix}`;
            suffix += 1;
          }
          if (names.has(targetBranch)) {
            return yield* Effect.fail(
              jjFailure(
                operation,
                input.cwd,
                `Could not find an available branch name for '${input.newBranch}'.`,
              ),
            );
          }
        }

        yield* run(
          operation,
          input.cwd,
          [
            "bookmark",
            "rename",
            bookmarkNameArgument(input.oldBranch),
            bookmarkNameArgument(targetBranch),
          ],
          {
            timeoutMs: 20_000,
          },
        ).pipe(
          mapJjFailure(
            operation,
            input.cwd,
            `Could not rename bookmark ${input.oldBranch} to ${targetBranch}.`,
          ),
        );

        // Without the workspace rename the bookmark-to-workspace mapping `listRefs` reports breaks
        // for this thread. `jj workspace rename` renames the workspace `cwd` belongs to and takes no
        // name, so it may only run when that workspace is the one the old bookmark named. From the
        // project root it would rename `default`.
        const workspaces = yield* driver
          .listWorkspaces(input.cwd)
          .pipe(mapJjFailure(operation, input.cwd, "Could not list Jujutsu workspaces."));
        const currentWorkspace = workspaces.find(
          (workspace) => workspace.root === paths.workspaceRoot,
        );
        if (currentWorkspace?.name === workspaceNameForRef(input.oldBranch)) {
          yield* run(
            operation,
            input.cwd,
            ["workspace", "rename", workspaceNameForRef(targetBranch)],
            { allowNonZeroExit: true, timeoutMs: 20_000 },
          ).pipe(Effect.ignore);
        }

        yield* moveBookmarkGitConfig(process, {
          gitDir: paths.gitDir,
          cwd: input.cwd,
          oldName: input.oldBranch,
          newName: targetBranch,
        });
        yield* driver.invalidateRepoCaches(input.cwd);

        return { branch: targetBranch };
      },
    );

    const listLocalBranchNames: JjRefsOps["listLocalBranchNames"] = Effect.fn(
      "JjRefs.listLocalBranchNames",
    )(function* (cwd: string) {
      const operation = "JjRefs.listLocalBranchNames";
      yield* repoPathsFor(operation, cwd);
      const bookmarks = yield* driver
        .listBookmarks(cwd)
        .pipe(mapJjFailure(operation, cwd, "Could not read this repository's bookmarks."));
      return bookmarks
        .filter((bookmark) => bookmark.remote === null)
        .map((bookmark) => bookmark.name);
    });

    const hasRefNamed: JjRefsOps["hasRefNamed"] = Effect.fn("JjRefs.hasRefNamed")(
      function* (input) {
        const operation = "JjRefs.hasRefNamed";
        yield* repoPathsFor(operation, input.cwd);
        const bookmarks = yield* driver
          .listBookmarks(input.cwd)
          .pipe(mapJjFailure(operation, input.cwd, "Could not read this repository's bookmarks."));
        return bookmarks.some(
          (bookmark) =>
            (bookmark.remote === null ? bookmark.name : `${bookmark.remote}/${bookmark.name}`) ===
            input.refName,
        );
      },
    );

    const resolveRefName: JjRefsOps["resolveRefName"] = Effect.fn("JjRefs.resolveRefName")(
      function* (cwd, refName) {
        const operation = "JjRefs.resolveRefName";
        yield* repoPathsFor(operation, cwd);
        const bookmarks = yield* driver
          .listBookmarks(cwd)
          .pipe(mapJjFailure(operation, cwd, "Could not read this repository's bookmarks."));
        const localName = refName.startsWith("refs/heads/")
          ? refName.slice("refs/heads/".length)
          : refName;
        const local = bookmarks.find(
          (bookmark) => bookmark.remote === null && bookmark.name === localName,
        );
        if (local !== undefined) return local.name;
        if (refName.startsWith("refs/heads/")) return null;
        const remoteName = refName.startsWith("refs/remotes/")
          ? refName.slice("refs/remotes/".length)
          : refName;
        const remote = bookmarks.find(
          (bookmark) =>
            bookmark.remote !== null && `${bookmark.remote}/${bookmark.name}` === remoteName,
        );
        if (remote !== undefined) return remote.name;
        if (refName.startsWith("refs/")) return null;
        const primaryRemote = yield* driver
          .resolvePrimaryRemoteName(cwd)
          .pipe(
            mapJjFailure(operation, cwd, "Could not resolve this repository's primary remote."),
          );
        return bookmarks.some(
          (bookmark) => bookmark.remote === primaryRemote && bookmark.name === refName,
        )
          ? refName
          : null;
      },
    );

    // jj has no force flag here: deleting a bookmark never discards the commits it pointed at.
    const deleteLocalBranch: JjRefsOps["deleteLocalBranch"] = Effect.fn("JjRefs.deleteLocalBranch")(
      function* (input) {
        const operation = "JjRefs.deleteLocalBranch";
        yield* repoPathsFor(operation, input.cwd);
        yield* run(
          operation,
          input.cwd,
          ["bookmark", "delete", exactStringPattern(input.refName)],
          {
            timeoutMs: 20_000,
          },
        ).pipe(mapJjFailure(operation, input.cwd, `Could not delete bookmark ${input.refName}.`));
        yield* driver.invalidateRepoCaches(input.cwd);
      },
    );

    return {
      hasRefNamed,
      resolveRefName,
      listRefs,
      createRef,
      switchRef,
      renameBranch,
      listLocalBranchNames,
      deleteLocalBranch,
      assertNoStrandedWork,
    };
  });

/** Carries the thread's PR base and upstream across a rename; jj itself ignores git branch config. */
const moveBookmarkGitConfig = Effect.fn("JjRefs.moveBookmarkGitConfig")(function* (
  process: VcsProcess.VcsProcess["Service"],
  input: {
    readonly gitDir: string | null;
    readonly cwd: string;
    readonly oldName: string;
    readonly newName: string;
  },
): Effect.fn.Return<void, never> {
  const gitDir = input.gitDir;
  if (gitDir === null) {
    return;
  }
  const git = (args: ReadonlyArray<string>) =>
    JjProcess.colocatedGitCommand(
      process,
      "JjRefs.moveBookmarkGitConfig",
      { gitDir, cwd: input.cwd },
      args,
      { allowNonZeroExit: true, timeoutMs: 10_000 },
    );

  for (const key of ["remote", "merge", "gh-merge-base", "t3-merge-base-ref"] as const) {
    const existing = yield* git(["config", "--get", `branch.${input.oldName}.${key}`]).pipe(
      Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "")),
      Effect.orElseSucceed(() => ""),
    );
    if (existing.length === 0) {
      continue;
    }
    const value = key === "merge" ? `refs/heads/${input.newName}` : existing;
    yield* git(["config", `branch.${input.newName}.${key}`, value]).pipe(Effect.ignore);
    yield* git(["config", "--unset", `branch.${input.oldName}.${key}`]).pipe(Effect.ignore);
  }
});
