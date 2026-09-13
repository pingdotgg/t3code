import type { FileDiffMetadata } from "@pierre/diffs";
import type { FileTreeBatchOperation, GitStatus } from "@pierre/trees";

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

/** Maps parsed diff files to tree entries, keeping the diff's own order. */
export function diffFileTreeEntries(
  files: ReadonlyArray<FileDiffMetadata>,
): ReadonlyArray<DiffFileTreeEntry> {
  return files.map((file) => ({ path: resolveFileDiffPath(file), status: toGitStatus(file) }));
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
