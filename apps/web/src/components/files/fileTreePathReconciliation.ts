import type { FileTreeBatchOperation } from "@pierre/trees";

// A batched operation reworks its folder's siblings, while a rebuild reworks every path. On flat
// folders of 50,000 and 332,000 entries a rebuild won somewhere between 200 and 500 operations.
const REBUILD_COST_IN_FOLDER_OPERATIONS = 300;

function parentOf(path: string): string {
  const end = path.endsWith("/") ? path.length - 1 : path.length;
  return path.slice(0, Math.max(0, path.lastIndexOf("/", end - 1)));
}

function countByParent(paths: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const parent = parentOf(path);
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return counts;
}

export function shouldRebuildFileTree(
  previousPaths: readonly string[],
  nextPaths: readonly string[],
  updates: readonly FileTreeBatchOperation[],
): boolean {
  // Up to this many operations, the estimate below can't exceed the rebuild, so skip counting.
  if (updates.length <= REBUILD_COST_IN_FOLDER_OPERATIONS) return false;
  const previousCounts = countByParent(previousPaths);
  const nextCounts = countByParent(nextPaths);
  let batchWork = 0;
  for (const update of updates) {
    if (update.type !== "add" && update.type !== "remove") continue;
    const parent = parentOf(update.path);
    batchWork += Math.max(previousCounts.get(parent) ?? 0, nextCounts.get(parent) ?? 0);
  }
  const rebuildWork = Math.max(previousPaths.length, nextPaths.length);
  return batchWork > REBUILD_COST_IN_FOLDER_OPERATIONS * rebuildWork;
}

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
