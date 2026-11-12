import type { FileDiffMetadata } from "@pierre/diffs";
import type {
  FileTreeBatchOperation,
  FileTreeIconConfig,
  FileTreeSortComparator,
  GitStatus,
} from "@pierre/trees";

import { resolveFileDiffPath } from "~/lib/diffRendering";
import { basenameOfPath, resolvePierreIconForEntry, T3_PIERRE_ICONS } from "~/pierre-icons";

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

// Pierre cannot store a file and a directory at the same path. Give only those
// files an invisible suffix, keeping real paths at the diff/viewer boundary.
export function diffFileTreeModel(paths: ReadonlyArray<string>) {
  const directories = new Set(collectDirectoryPaths(paths));
  // Icon overrides match basenames case-insensitively, so aliases must also avoid
  // real names in other directories, including names that already contain the suffix.
  const occupiedNames = new Set(paths.flatMap((path) => path.toLowerCase().split("/")));
  const selectionByModelPath = new Map<string, string>();
  const modelBySelectionPath = new Map<string, string>();
  const byFileName: FileTreeIconConfig["byFileName"] = { ...T3_PIERRE_ICONS.byFileName };
  const modelPaths = paths.map((path) => {
    if (!directories.has(`${path}/`)) return path;
    let modelPath = path;
    do {
      modelPath += "\u200b";
    } while (occupiedNames.has(basenameOfPath(modelPath).toLowerCase()));
    occupiedNames.add(basenameOfPath(modelPath).toLowerCase());
    selectionByModelPath.set(modelPath, path);
    modelBySelectionPath.set(path, modelPath);
    const icon = resolvePierreIconForEntry(path, "file");
    if (icon !== null) byFileName[basenameOfPath(modelPath)] = icon;
    return modelPath;
  });
  return {
    paths: modelBySelectionPath.size === 0 ? paths : modelPaths,
    selectionPath: (modelPath: string) => selectionByModelPath.get(modelPath) ?? modelPath,
    modelPath: (path: string) => modelBySelectionPath.get(path) ?? path,
    icons: modelBySelectionPath.size === 0 ? T3_PIERRE_ICONS : { ...T3_PIERRE_ICONS, byFileName },
  };
}

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

// A flat list in tree order: each directory stays contiguous, siblings ranked as
// compareDiffFileTreeEntries ranks them, so the list never disagrees with the tree.
export function orderDiffFilesLikeTree(
  files: ReadonlyArray<FileDiffMetadata>,
): ReadonlyArray<FileDiffMetadata> {
  const paths = files.map(resolveFileDiffPath);
  const positions = diffFileTreePositions(paths);
  const keys = paths.map((path) => {
    const key: number[] = [];
    let directory = "";
    for (const segment of path.split("/").slice(0, -1)) {
      directory += `${segment}/`;
      key.push(positions.get(directory)!);
    }
    key.push(positions.get(path)!);
    return key;
  });
  return files
    .map((file, index) => ({ file, key: keys[index]! }))
    .toSorted((left, right) => {
      const length = Math.min(left.key.length, right.key.length);
      for (let index = 0; index < length; index++) {
        const difference = left.key[index]! - right.key[index]!;
        if (difference !== 0) return difference;
      }
      return left.key.length - right.key.length;
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
  const removedDirectories = [...previousDirectories]
    .filter((directory) => !nextDirectories.has(directory))
    .toSorted((left, right) => pathDepth(right) - pathDepth(left));
  for (const directory of removedDirectories) {
    updates.push({ type: "remove", path: directory, recursive: true });
  }

  const addedDirectories = [...nextDirectories]
    .filter((directory) => !previousDirectories.has(directory))
    .toSorted((left, right) => pathDepth(left) - pathDepth(right));
  for (const directory of addedDirectories) updates.push({ type: "add", path: directory });
  for (const path of nextPaths) {
    if (!previous.has(path)) updates.push({ type: "add", path });
  }

  return updates;
}
