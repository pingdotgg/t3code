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
  readonly reviewed?: boolean;
  readonly unresolvedComments?: number;
}

/** Pierre folder ids end with a slash; a selected folder includes its hidden descendants. */
export function diffFileTreeReviewEntries(
  entries: ReadonlyArray<DiffFileTreeEntry>,
  selectedPaths: ReadonlyArray<string>,
  clickedPath: string,
): ReadonlyArray<DiffFileTreeEntry> {
  const contains = (target: string, path: string) =>
    target.endsWith("/") ? path.startsWith(target) : path === target;
  const targets = selectedPaths.some((path) => contains(path, clickedPath))
    ? selectedPaths
    : [clickedPath];
  const exact = new Set(targets);
  const folders = targets.filter((path) => path.endsWith("/"));
  return entries.filter(
    (entry) => exact.has(entry.path) || folders.some((path) => entry.path.startsWith(path)),
  );
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
