// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import { type VcsError, VcsRepositoryDetectionError } from "@t3tools/contracts";

export const JJ_REPOSITORY_DETECTION_ENABLED = true;

export type VcsMarker = "jj" | "git";

export interface VcsMarkerRoot {
  /** Nearest ancestor of `cwd` (inclusive) holding a jj or Git marker. Realpath-normalised. */
  readonly root: string;
  /** `"jj"` when that directory holds `.jj`; `"git"` for `.git` or a bare Git directory. */
  readonly marker: VcsMarker;
}

export interface JjRepoPaths {
  /** Workspace root for `cwd`, the directory holding the `.jj` this cwd belongs to. */
  readonly workspaceRoot: string;
  /** Root of the `default` workspace, the only one that can hold `.git`. */
  readonly mainWorkspaceRoot: string;
  /** `<mainWorkspaceRoot>/.git` when the repo is colocated; `null` otherwise. */
  readonly gitDir: string | null;
  /** True when `<workspaceRoot>/.jj/repo` is a file (a secondary workspace). */
  readonly isSecondaryWorkspace: boolean;
}

const isDirectory = (fileSystem: FileSystem.FileSystem, candidate: string) =>
  fileSystem.stat(candidate).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false),
  );

const exists = (fileSystem: FileSystem.FileSystem, candidate: string) =>
  fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));

/** Bare Git directories are ancestry boundaries even though they have no `.git` entry. */
export const isBareGitRepository = Effect.fn("JjRepo.isBareGitRepository")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
): Effect.fn.Return<boolean, never> {
  return (
    (yield* fileSystem.stat(path.join(root, "HEAD")).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    )) &&
    (yield* isDirectory(fileSystem, path.join(root, "objects"))) &&
    (yield* isDirectory(fileSystem, path.join(root, "refs")))
  );
});

/** A gitdir file alone can also be a submodule or separate Git directory, not a linked worktree. */
export const isGitLinkedWorktree = Effect.fn("JjRepo.isGitLinkedWorktree")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  workspaceRoot: string,
): Effect.fn.Return<boolean, never> {
  const pointer = yield* fileSystem
    .readFileString(path.join(workspaceRoot, ".git"))
    .pipe(Effect.orElseSucceed(() => ""));
  const gitDir = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
  if (!gitDir) return false;
  return yield* fileSystem.stat(path.join(path.resolve(workspaceRoot, gitDir), "commondir")).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.orElseSucceed(() => false),
  );
});

/**
 * Walks up from `cwd` and stops at the FIRST directory holding `.jj`, `.git`, or a bare Git
 * directory. Pure filesystem, no subprocess. A nearer Git repository outranks a `.jj` further up,
 * so no operation ever reaches across into the outer workspace.
 *
 * `null` when `cwd` itself does not exist. A deleted thread directory must never walk up into an
 * unrelated repository above it, and it is null when neither marker is found up to the filesystem root.
 */
export const findVcsMarkerRoot = Effect.fn("JjRepo.findVcsMarkerRoot")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
): Effect.fn.Return<VcsMarkerRoot | null, never> {
  if (!(yield* isDirectory(fileSystem, cwd))) {
    return null;
  }

  let current = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));

  for (;;) {
    if (yield* isDirectory(fileSystem, path.join(current, ".jj"))) {
      return { root: current, marker: "jj" };
    }
    if (yield* exists(fileSystem, path.join(current, ".git"))) {
      return { root: current, marker: "git" };
    }
    if (yield* isBareGitRepository(fileSystem, path, current)) {
      return { root: current, marker: "git" };
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
});

/**
 * PURE. `<workspaceRoot>/.jj/repo` in a secondary workspace is a pointer to the main repo's
 * `.jj/repo`, usually relative, and relative to `<workspaceRoot>/.jj`, not to the workspace root.
 */
export function mainWorkspaceRootFromRepoPointer(
  workspaceRoot: string,
  repoPointerContents: string,
): string {
  const pointer = repoPointerContents.trim();
  const resolved = NodePath.isAbsolute(pointer)
    ? pointer
    : NodePath.resolve(NodePath.join(workspaceRoot, ".jj"), pointer);
  return NodePath.dirname(NodePath.dirname(resolved));
}

export const resolveJjRepoPaths = Effect.fn("JjRepo.resolveJjRepoPaths")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  workspaceRoot: string,
): Effect.fn.Return<JjRepoPaths, VcsError> {
  const resolvedWorkspaceRoot = yield* fileSystem
    .realPath(workspaceRoot)
    .pipe(Effect.orElseSucceed(() => workspaceRoot));
  const repoPointer = path.join(resolvedWorkspaceRoot, ".jj", "repo");
  const isMainWorkspace = yield* isDirectory(fileSystem, repoPointer);

  let mainWorkspaceRoot = resolvedWorkspaceRoot;
  if (!isMainWorkspace) {
    const pointerContents = yield* fileSystem.readFileString(repoPointer).pipe(
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            operation: "JjRepo.resolveJjRepoPaths",
            cwd: workspaceRoot,
            detail: "Could not read the Jujutsu workspace repository pointer.",
            cause,
          }),
      ),
    );
    const pointedRoot = mainWorkspaceRootFromRepoPointer(resolvedWorkspaceRoot, pointerContents);
    mainWorkspaceRoot = yield* fileSystem
      .realPath(pointedRoot)
      .pipe(Effect.orElseSucceed(() => pointedRoot));
  }

  const gitDirCandidate = path.join(mainWorkspaceRoot, ".git");
  const colocated = yield* isDirectory(fileSystem, gitDirCandidate);

  return {
    workspaceRoot: resolvedWorkspaceRoot,
    mainWorkspaceRoot,
    gitDir: colocated ? gitDirCandidate : null,
    isSecondaryWorkspace: !isMainWorkspace,
  } satisfies JjRepoPaths;
});
