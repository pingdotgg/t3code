import type { FileTreeBatchOperation } from "@pierre/trees";

function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

export function buildFileTreePathUpdates(
  previousPaths: readonly string[],
  nextPaths: readonly string[],
): FileTreeBatchOperation[] {
  const previous = new Set(previousPaths);
  const next = new Set(nextPaths);
  const removedDirectoryRoots: string[] = [];
  const updates: FileTreeBatchOperation[] = [];

  const removedPaths = previousPaths
    .filter((path) => !next.has(path))
    .toSorted((left, right) => pathDepth(left) - pathDepth(right));
  for (const path of removedPaths) {
    if (removedDirectoryRoots.some((directory) => path.startsWith(directory))) continue;
    const recursive = path.endsWith("/");
    updates.push({ type: "remove", path, ...(recursive ? { recursive: true } : {}) });
    if (recursive) removedDirectoryRoots.push(path);
  }

  const addedPaths = nextPaths
    .filter((path) => !previous.has(path))
    .toSorted((left, right) => pathDepth(left) - pathDepth(right));
  for (const path of addedPaths) updates.push({ type: "add", path });

  return updates;
}
