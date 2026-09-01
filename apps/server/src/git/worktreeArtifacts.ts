/**
 * worktreeArtifacts - Regenerable build-artifact discovery and removal for
 * worktree directories.
 *
 * Used by the settle-time worktree cleanup to reclaim disk from parked
 * threads without touching tracked files: everything removed here is
 * recreated by the project's package manager or build tool on the next run.
 *
 * @module worktreeArtifacts
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as VcsProcess from "../vcs/VcsProcess.ts";

// Directory names that are always safe to delete wherever they appear.
const ARTIFACT_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".next",
  ".nuxt",
  ".turbo",
  ".svelte-kit",
]);

// `target` is only a build artifact when it belongs to a Cargo project, so
// it is matched exclusively next to a sibling `Cargo.toml`.
const CARGO_ARTIFACT_DIRECTORY = "target";
const CARGO_MANIFEST_FILE = "Cargo.toml";

// Artifact roots live near the top of real repos; a depth cap keeps a
// pathological tree from turning the scan into a full-disk walk.
const MAX_SCAN_DEPTH = 8;

/**
 * Whether `worktreePath` points at a linked git worktree.
 *
 * Linked worktrees keep a `.git` pointer file, but so does a primary
 * checkout cloned with `--separate-git-dir`, so the entry type alone is not
 * enough. The pointer's `gitdir:` target settles it: a linked worktree's
 * private git dir holds a `commondir` file referencing the shared `.git`,
 * while a detached full git dir has none. The private dir's `gitdir`
 * back-reference must also resolve to this worktree's own `.git` pointer,
 * so a pointer borrowed from another worktree does not vouch for a
 * directory git never registered. Anything that fails to parse reads as
 * "not a worktree" so the cleanup never guesses.
 */
export const isLinkedWorktreePath = Effect.fn("isLinkedWorktreePath")(function* (
  worktreePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pointerPath = path.join(worktreePath, ".git");
  const info = yield* fileSystem.stat(pointerPath).pipe(Effect.orElseSucceed(() => null));
  if (info === null || info.type !== "File") {
    return false;
  }

  const pointer = yield* fileSystem
    .readFileString(pointerPath)
    .pipe(Effect.orElseSucceed(() => null));
  const gitDirMatch = pointer?.match(/^gitdir:\s*(.+)\s*$/m);
  if (!gitDirMatch) {
    return false;
  }
  const gitDir = path.isAbsolute(gitDirMatch[1]!)
    ? gitDirMatch[1]!
    : path.join(worktreePath, gitDirMatch[1]!);

  const commonDirInfo = yield* fileSystem
    .stat(path.join(gitDir, "commondir"))
    .pipe(Effect.orElseSucceed(() => null));
  if (commonDirInfo === null || commonDirInfo.type !== "File") {
    return false;
  }

  const backReference = yield* fileSystem
    .readFileString(path.join(gitDir, "gitdir"))
    .pipe(Effect.orElseSucceed(() => null));
  const backReferencePath = backReference?.trim();
  if (!backReferencePath) {
    return false;
  }
  const canonicalBackReference = yield* fileSystem
    .realPath(
      path.isAbsolute(backReferencePath) ? backReferencePath : path.join(gitDir, backReferencePath),
    )
    .pipe(Effect.orElseSucceed(() => null));
  const canonicalPointer = yield* fileSystem
    .realPath(pointerPath)
    .pipe(Effect.orElseSucceed(() => null));
  return canonicalBackReference !== null && canonicalBackReference === canonicalPointer;
});

/**
 * Find regenerable build-artifact directories inside a worktree.
 *
 * Matches `node_modules`, framework caches, and Cargo `target` directories
 * (only next to a `Cargo.toml`). Matched directories are returned without
 * being descended into, `.git` is never entered, and symlinked directories
 * are never followed so the scan cannot escape the worktree.
 */
export const findWorktreeArtifactDirectories = Effect.fn("findWorktreeArtifactDirectories")(
  function* (worktreePath: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(worktreePath);

    const found: Array<string> = [];
    const pending: Array<{ readonly directory: string; readonly depth: number }> = [
      { directory: root, depth: 0 },
    ];

    while (pending.length > 0) {
      const { directory, depth } = pending.pop()!;
      const entries = yield* fileSystem
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed(() => [] as Array<string>));
      // The manifest must be a regular file: a directory named Cargo.toml
      // does not make a sibling `target` directory a build artifact.
      const hasCargoManifest =
        entries.includes(CARGO_MANIFEST_FILE) &&
        (yield* fileSystem
          .stat(path.join(directory, CARGO_MANIFEST_FILE))
          .pipe(Effect.orElseSucceed(() => null)))?.type === "File";

      for (const entry of entries) {
        if (entry === ".git") {
          continue;
        }
        const absolute = path.join(directory, entry);
        const info = yield* fileSystem.stat(absolute).pipe(Effect.orElseSucceed(() => null));
        if (info === null || info.type !== "Directory") {
          continue;
        }
        if (
          ARTIFACT_DIRECTORY_NAMES.has(entry) ||
          (entry === CARGO_ARTIFACT_DIRECTORY && hasCargoManifest)
        ) {
          found.push(absolute);
          continue;
        }
        if (depth + 1 >= MAX_SCAN_DEPTH) {
          continue;
        }
        // `stat` follows symlinks, so a symlinked directory reports as a
        // plain directory; comparing against its canonical path is what
        // keeps the walk inside the worktree.
        const canonical = yield* fileSystem
          .realPath(absolute)
          .pipe(Effect.orElseSucceed(() => null));
        if (canonical !== absolute) {
          continue;
        }
        pending.push({ directory: absolute, depth: depth + 1 });
      }
    }

    return found;
  },
);

/**
 * Whether git vouches that an artifact directory holds only regenerable
 * contents: the directory must be ignored and contain no tracked files.
 * A failed git invocation reads as "not verified" so nothing is deleted on
 * guesswork.
 */
const isVerifiedRegenerable = Effect.fn("isVerifiedRegenerable")(function* (input: {
  readonly worktreePath: string;
  readonly relativePath: string;
}) {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const checkIgnore = yield* vcsProcess
    .run({
      operation: "worktreeArtifacts.checkIgnore",
      command: "git",
      args: ["check-ignore", "-q", "--", input.relativePath],
      cwd: input.worktreePath,
      allowNonZeroExit: true,
    })
    .pipe(Effect.orElseSucceed(() => null));
  if (checkIgnore?.exitCode !== 0) {
    return false;
  }

  const trackedFiles = yield* vcsProcess
    .run({
      operation: "worktreeArtifacts.listTrackedFiles",
      command: "git",
      args: ["ls-files", "--", input.relativePath],
      cwd: input.worktreePath,
    })
    .pipe(Effect.orElseSucceed(() => null));
  return trackedFiles !== null && trackedFiles.stdout.trim() === "";
});

/**
 * Remove all regenerable build-artifact directories from a worktree.
 *
 * A directory is only deleted after git verifies it is ignored and holds no
 * tracked files; anything else lands in `skipped` untouched. Removal is
 * best-effort per directory: one undeletable artifact does not abort the
 * rest of the sweep.
 */
export const removeWorktreeArtifacts = Effect.fn("removeWorktreeArtifacts")(function* (
  worktreePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The scan returns canonical paths, so relative paths and the git cwd must
  // start from the same canonical root.
  const root = yield* fileSystem.realPath(worktreePath);
  const artifacts = yield* findWorktreeArtifactDirectories(root);

  const removed: Array<string> = [];
  const failed: Array<string> = [];
  const skipped: Array<string> = [];
  for (const artifact of artifacts) {
    const verified = yield* isVerifiedRegenerable({
      worktreePath: root,
      relativePath: path.relative(root, artifact),
    });
    if (!verified) {
      skipped.push(artifact);
      continue;
    }
    const succeeded = yield* fileSystem.remove(artifact, { recursive: true, force: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (succeeded) {
      removed.push(artifact);
    } else {
      failed.push(artifact);
    }
  }

  return { removed, failed, skipped };
});
