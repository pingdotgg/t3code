import type { FileDiffMetadata } from "@pierre/diffs";
import type { FileTreeBatchOperation, FileTreeSortComparator, GitStatus } from "@pierre/trees";

import { resolveFileDiffPath } from "~/lib/diffRendering";

/** One changed file as the tree shows it: its current path and how it changed. */
export interface DiffFileTreeEntry {
  readonly path: string;
  readonly status: GitStatus;
}

function toGitStatus(file: FileDiffMetadata): GitStatus {
  switch (file.type) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    case "change":
      return "modified";
  }
}

/**
 * Maps parsed diff files to tree entries, keeping the diff's own order. A path
 * appears once: a type change (regular file to symlink) is a deletion plus an
 * addition of the same path, and the tree shows the surviving file as modified.
 */
export function diffFileTreeEntries(
  files: ReadonlyArray<FileDiffMetadata>,
): ReadonlyArray<DiffFileTreeEntry> {
  const statusByPath = new Map<string, GitStatus>();
  for (const file of files) {
    const path = resolveFileDiffPath(file);
    const status = toGitStatus(file);
    const previous = statusByPath.get(path);
    statusByPath.set(path, previous === undefined || previous === status ? status : "modified");
  }
  return [...statusByPath].map(([path, status]) => ({ path, status }));
}

/**
 * Pierre stores one filesystem. A diff path that is also a directory prefix of another
 * path (`office` and `office/config.ts`, or the reverse) cannot be inserted as-is.
 * The file keeps a zero-width suffix so the row label stays the file name and the
 * directory can still be created. Callers translate with `selectionPath` and `modelPath`.
 */
const DIFF_FILE_TREE_FILE_MARK = "\u200b";

const identityPath = (path: string) => path;

export interface DiffFileTreeModel {
  /** Paths safe to pass to Pierre. Same array as the input when nothing collides. */
  readonly paths: ReadonlyArray<string>;
  /** Pierre path to the diff path a click should open. */
  readonly selectionPath: (modelPath: string) => string;
  /** Diff path to the path stored in the tree. */
  readonly modelPath: (path: string) => string;
}

function collidingFilePaths(paths: ReadonlyArray<string>): ReadonlySet<string> | null {
  if (paths.length < 2) return null;
  const unique = [...new Set(paths)].toSorted();
  const colliding = new Set<string>();
  for (let index = 0; index < unique.length; index += 1) {
    const path = unique[index]!;
    const directoryPrefix = `${path}/`;
    for (let next = index + 1; next < unique.length; next += 1) {
      const other = unique[next]!;
      if (!other.startsWith(path)) break;
      if (other.startsWith(directoryPrefix)) {
        colliding.add(path);
        break;
      }
    }
  }
  return colliding.size === 0 ? null : colliding;
}

function modelPathForCollidingFile(path: string, occupied: Set<string>): string {
  let modelPath = path;
  const collides = (candidate: string) => {
    if (occupied.has(candidate)) return true;
    const prefix = `${candidate}/`;
    for (const other of occupied) {
      if (other.startsWith(prefix)) return true;
    }
    return false;
  };
  do {
    modelPath += DIFF_FILE_TREE_FILE_MARK;
  } while (collides(modelPath));
  return modelPath;
}

export function diffFileTreeModel(paths: ReadonlyArray<string>): DiffFileTreeModel {
  const colliding = collidingFilePaths(paths);
  if (colliding === null) {
    return { paths, selectionPath: identityPath, modelPath: identityPath };
  }
  const occupied = new Set(paths);
  const modelPaths = paths.map((path) => {
    if (!colliding.has(path)) return path;
    const modelPath = modelPathForCollidingFile(path, occupied);
    occupied.add(modelPath);
    return modelPath;
  });
  const selectionByModelPath = new Map<string, string>();
  const modelBySelectionPath = new Map<string, string>();
  paths.forEach((path, index) => {
    const modelPath = modelPaths[index]!;
    selectionByModelPath.set(modelPath, path);
    modelBySelectionPath.set(path, modelPath);
  });
  return {
    paths: modelPaths,
    selectionPath: (modelPath) => selectionByModelPath.get(modelPath) ?? modelPath,
    modelPath: (path) => modelBySelectionPath.get(path) ?? path,
  };
}

/**
 * Every directory on the way to each file, registered with the trailing slash Pierre uses for
 * directory ids. Parents come before children so the tree can add them in order.
 */
export function collectDirectoryPaths(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const directories = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    let directory = "";
    for (const segment of segments.slice(0, -1)) {
      directory += `${segment}/`;
      directories.add(directory);
    }
  }
  return [...directories];
}

/** A folder takes the position of its first file in the diff. */
export function diffFileTreePositions(paths: ReadonlyArray<string>): ReadonlyMap<string, number> {
  const positions = new Map<string, number>();
  paths.forEach((path, index) => {
    positions.set(path, index);
    let directory = "";
    for (const segment of path.split("/").slice(0, -1)) {
      directory += `${segment}/`;
      if (!positions.has(directory)) positions.set(directory, index);
    }
  });
  return positions;
}

export function compareDiffFileTreeEntries(
  getPositions: () => ReadonlyMap<string, number>,
): FileTreeSortComparator {
  return (left, right) => {
    const positions = getPositions();
    return (
      (positions.get(left.path) ?? Number.MAX_SAFE_INTEGER) -
        (positions.get(right.path) ?? Number.MAX_SAFE_INTEGER) ||
      left.depth - right.depth ||
      left.path.localeCompare(right.path)
    );
  };
}

function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

/**
 * The adds and removes that turn one set of file paths into another, so a diff that changes
 * under the reader (a new slice, a refresh after an agent edit) keeps the directories they
 * have already opened or closed instead of rebuilding the tree from scratch.
 *
 * Directories are removed only once no file needs them; a directory that gains its first file
 * is added before that file.
 */
export function buildDiffFileTreeUpdates(
  previousPaths: ReadonlyArray<string>,
  nextPaths: ReadonlyArray<string>,
): FileTreeBatchOperation[] {
  const previousDirectories = new Set(collectDirectoryPaths(previousPaths));
  const nextDirectories = new Set(collectDirectoryPaths(nextPaths));
  const previous = new Set(previousPaths);
  const next = new Set(nextPaths);
  const updates: FileTreeBatchOperation[] = [];

  for (const path of previousPaths) {
    if (!next.has(path)) updates.push({ type: "remove", path });
  }
  // Deepest first: a directory can only go once everything under it has.
  const removedDirectories = [...previousDirectories]
    .filter((directory) => !nextDirectories.has(directory))
    .toSorted((left, right) => pathDepth(right) - pathDepth(left));
  for (const directory of removedDirectories) {
    updates.push({ type: "remove", path: directory, recursive: true });
  }

  // Shallowest first: a file's directory has to exist before the file does.
  const addedDirectories = [...nextDirectories]
    .filter((directory) => !previousDirectories.has(directory))
    .toSorted((left, right) => pathDepth(left) - pathDepth(right));
  for (const directory of addedDirectories) updates.push({ type: "add", path: directory });
  for (const path of nextPaths) {
    if (!previous.has(path)) updates.push({ type: "add", path });
  }

  return updates;
}
