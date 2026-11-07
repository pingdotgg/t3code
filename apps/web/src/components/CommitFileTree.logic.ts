import { buildTurnDiffTree, type TurnDiffTreeNode } from "~/lib/turnDiffTree";

export interface CommitFile {
  path: string;
  insertions: number;
  deletions: number;
}

export interface CommitFileTreeRow {
  node: TurnDiffTreeNode;
  depth: number;
}

export type CommitFileTreeSelection = "all" | "some" | "none";

export function buildCommitFileTree(files: ReadonlyArray<CommitFile>): TurnDiffTreeNode[] {
  return buildTurnDiffTree(
    files.map((file) => ({
      path: file.path,
      additions: file.insertions,
      deletions: file.deletions,
    })),
    { splitBackslashes: false },
  );
}

export function flattenCommitFileTree(
  nodes: ReadonlyArray<TurnDiffTreeNode>,
  collapsedDirectories: ReadonlySet<string>,
  depth = 0,
  rows: CommitFileTreeRow[] = [],
): CommitFileTreeRow[] {
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.kind === "directory" && !collapsedDirectories.has(node.path)) {
      flattenCommitFileTree(node.children, collapsedDirectories, depth + 1, rows);
    }
  }
  return rows;
}

function collectFilePaths(node: TurnDiffTreeNode, paths: string[] = []): string[] {
  if (node.kind === "file") {
    paths.push(node.path);
    return paths;
  }
  for (const child of node.children) collectFilePaths(child, paths);
  return paths;
}

export function resolveCommitFileTreeSelection(
  node: TurnDiffTreeNode,
  excludedFiles: ReadonlySet<string>,
): CommitFileTreeSelection {
  const paths = collectFilePaths(node);
  const excludedCount = paths.filter((path) => excludedFiles.has(path)).length;
  if (excludedCount === 0) return "all";
  return excludedCount === paths.length ? "none" : "some";
}

/** A fully included node is excluded; a partly or fully excluded node is included. */
export function toggleCommitFileTreeNode(
  node: TurnDiffTreeNode,
  excludedFiles: ReadonlySet<string>,
): Set<string> {
  const next = new Set(excludedFiles);
  const excludeAll = resolveCommitFileTreeSelection(node, excludedFiles) === "all";
  for (const path of collectFilePaths(node)) {
    if (excludeAll) next.add(path);
    else next.delete(path);
  }
  return next;
}
