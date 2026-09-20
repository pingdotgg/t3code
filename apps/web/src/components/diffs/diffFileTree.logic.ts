import type { FileDiffMetadata } from "@pierre/diffs";
import type { FileTreeBatchOperation, FileTreeSortComparator, GitStatus } from "@pierre/trees";

import { resolveFileDiffPath, resolveFileDiffPreviousPath } from "~/lib/diffRendering";

/** One changed file as the tree shows it: its current path and how it changed. */
export interface DiffFileTreeEntry {
  readonly path: string;
  readonly status: GitStatus;
  readonly previousPath?: string;
  readonly renamedWithChanges?: boolean;
  readonly viewed?: boolean;
  readonly viewedStale?: boolean;
}

export function diffFileTreeViewedCounts(entries: ReadonlyArray<DiffFileTreeEntry>) {
  const counts = new Map<string, { total: number; viewed: number; stale: number }>();
  for (const entry of entries) {
    const paths = [entry.path, ...collectDirectoryPaths([entry.path])];
    for (const path of paths) {
      const count = counts.get(path) ?? { total: 0, viewed: 0, stale: 0 };
      count.total++;
      if (entry.viewed) count.viewed++;
      if (entry.viewedStale) count.stale++;
      counts.set(path, count);
    }
  }
  return counts;
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
  const entries = new Map<string, DiffFileTreeEntry>();
  for (const file of files) {
    const entry: DiffFileTreeEntry = {
      path: resolveFileDiffPath(file),
      status: toGitStatus(file),
      ...(file.type === "rename-pure" || file.type === "rename-changed"
        ? {
            previousPath: resolveFileDiffPreviousPath(file),
            renamedWithChanges: file.type === "rename-changed",
          }
        : {}),
    };
    const previous = entries.get(entry.path);
    entries.set(
      entry.path,
      previous
        ? { ...previous, status: previous.status === entry.status ? entry.status : "modified" }
        : entry,
    );
  }
  return [...entries.values()];
}

export function changedPathParts(previousPath: string, path: string) {
  const before = Array.from(previousPath);
  const after = Array.from(path);
  let start = 0;
  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < Math.min(before.length, after.length) - start &&
    before[before.length - end - 1] === after[after.length - end - 1]
  )
    end++;
  return {
    prefix: before.slice(0, start).join(""),
    before: before.slice(start, before.length - end).join(""),
    after: after.slice(start, after.length - end).join(""),
    suffix: before.slice(before.length - end).join(""),
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

export function orderFilesByTree<T>(
  files: ReadonlyArray<T>,
  getPath: (file: T) => string,
): ReadonlyArray<T> {
  const positions = diffFileTreePositions(files.map(getPath));
  return files
    .map((file) => {
      let path = "";
      const segments = getPath(file).split("/");
      const ranks = segments.map((segment, index) => {
        path += segment + (index < segments.length - 1 ? "/" : "");
        return positions.get(path)!;
      });
      return { file, ranks };
    })
    .sort((left, right) => {
      for (let index = 0; index < Math.min(left.ranks.length, right.ranks.length); index++) {
        const difference = left.ranks[index]! - right.ranks[index]!;
        if (difference !== 0) return difference;
      }
      return left.ranks.length - right.ranks.length;
    })
    .map(({ file }) => file);
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
