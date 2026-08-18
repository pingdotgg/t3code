import type { VcsStatusResult, VcsWorkingTreeFileStatus } from "@t3tools/contracts";

const FILE_TREE_GIT_STATUS_PRIORITY: Record<VcsWorkingTreeFileStatus, number> = {
  deleted: 4,
  modified: 3,
  renamed: 3,
  added: 2,
  untracked: 1,
};

function normalizeGitTreePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

function preferFileTreeGitStatus(
  current: VcsWorkingTreeFileStatus | undefined,
  next: VcsWorkingTreeFileStatus,
): VcsWorkingTreeFileStatus {
  if (current === undefined) return next;
  return FILE_TREE_GIT_STATUS_PRIORITY[next] > FILE_TREE_GIT_STATUS_PRIORITY[current]
    ? next
    : current;
}

function isPathUnderGitTreePrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Explorer decorations keyed by the caller's tree-path identity.
 * Untracked git directories (trailing slash) expand onto matching tree files.
 * Ancestor folders inherit the strongest child status.
 */
export function workingTreeGitStatusByPath(
  files: VcsStatusResult["workingTree"]["files"],
  treePaths: ReadonlyArray<string> = [],
): ReadonlyMap<string, VcsWorkingTreeFileStatus> {
  const byPath = new Map<string, VcsWorkingTreeFileStatus>();
  const originalsByNormalized = new Map<string, string[]>();
  for (const treePath of treePaths) {
    const normalized = normalizeGitTreePath(treePath);
    if (normalized.length === 0) continue;
    const existing = originalsByNormalized.get(normalized);
    if (existing) existing.push(treePath);
    else originalsByNormalized.set(normalized, [treePath]);
  }

  const assign = (normalized: string, status: VcsWorkingTreeFileStatus) => {
    const originals = originalsByNormalized.get(normalized);
    if (originals === undefined) {
      byPath.set(normalized, preferFileTreeGitStatus(byPath.get(normalized), status));
      return;
    }
    for (const original of originals) {
      byPath.set(original, preferFileTreeGitStatus(byPath.get(original), status));
    }
  };

  for (const file of files) {
    const status = file.status;
    if (status === undefined) continue;
    const normalized = normalizeGitTreePath(file.path);
    if (normalized.length === 0) continue;
    assign(normalized, status);
    if (status !== "untracked" || !file.path.endsWith("/")) continue;
    for (const treePath of treePaths) {
      const treeNormalized = normalizeGitTreePath(treePath);
      if (treeNormalized.length === 0) continue;
      if (!isPathUnderGitTreePrefix(treeNormalized, normalized)) continue;
      byPath.set(treePath, preferFileTreeGitStatus(byPath.get(treePath), "untracked"));
    }
  }

  for (const [path, status] of Array.from(byPath.entries())) {
    const segments = normalizeGitTreePath(path)
      .split("/")
      .filter((segment) => segment.length > 0);
    let ancestor = "";
    for (const segment of segments.slice(0, -1)) {
      ancestor = ancestor.length > 0 ? `${ancestor}/${segment}` : segment;
      assign(ancestor, status);
    }
  }

  return byPath;
}
