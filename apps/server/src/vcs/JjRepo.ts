// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import { type VcsError, VcsRepositoryDetectionError } from "@t3tools/contracts";

export type VcsMarker = "jj" | "git";

export interface VcsMarkerRoot {
  /** Nearest ancestor of `cwd` (inclusive) holding `.jj` or `.git`. Realpath-normalised. */
  readonly root: string;
  /** `"jj"` when that directory holds `.jj` (colocated or not); `"git"` when it holds only `.git`. */
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

/**
 * Walks up from `cwd` and stops at the FIRST directory holding `.jj` or `.git`. Pure filesystem, no
 * subprocess. A nearer `.git` outranks a `.jj` further up, so a git worktree nested inside a jj repo
 * keeps its own driver and no operation ever reaches across into the outer workspace.
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
