import type { FileTreeBatchOperation } from "@pierre/trees";

// Each batched operation reworks every sibling. Both costs grow with the listing, and a rebuild
// wins at about 300 operations whether the folder holds 50,000 entries or 332,000.
export const MAX_INCREMENTAL_FILE_TREE_UPDATES = 300;

function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

function isInsideRemovedDirectory(path: string, removedRoots: ReadonlySet<string>): boolean {
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
    if (removedRoots.has(path.slice(0, slash + 1))) return true;
  }
  return false;
}

export function buildFileTreePathUpdates(
  previousPaths: readonly string[],
  nextPaths: readonly string[],
): FileTreeBatchOperation[] {
  const previous = new Set(previousPaths);
  const next = new Set(nextPaths);
  const removedDirectoryRoots = new Set<string>();
  const updates: FileTreeBatchOperation[] = [];

  const removedPaths = previousPaths
    .filter((path) => !next.has(path))
    .toSorted((left, right) => pathDepth(left) - pathDepth(right));
  for (const path of removedPaths) {
    if (isInsideRemovedDirectory(path, removedDirectoryRoots)) continue;
    const recursive = path.endsWith("/");
    updates.push({ type: "remove", path, ...(recursive ? { recursive: true } : {}) });
    if (recursive) removedDirectoryRoots.add(path);
  }

  const addedPaths = nextPaths
    .filter((path) => !previous.has(path))
    .toSorted((left, right) => pathDepth(left) - pathDepth(right));
  for (const path of addedPaths) updates.push({ type: "add", path });

  return updates;
}
