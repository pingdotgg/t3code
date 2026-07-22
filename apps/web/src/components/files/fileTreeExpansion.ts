import type { ProjectEntry } from "@t3tools/contracts";

export const COLLAPSE_ALL_FOLDERS_LABEL = "Collapse all folders";
export const EXPAND_ALL_FOLDERS_LABEL = "Expand all folders";

interface FileTreeExpansionDirectoryItem {
  collapse(): void;
  expand(): void;
  isDirectory(): true;
  isExpanded(): boolean;
}

interface FileTreeExpansionFileItem {
  isDirectory(): false;
}

type FileTreeExpansionItem = FileTreeExpansionDirectoryItem | FileTreeExpansionFileItem;

interface FileTreeExpansionModel {
  getItem(path: string): FileTreeExpansionItem | null;
  isSearchOpen(): boolean;
  resetPaths(paths: readonly string[], options: { initialExpandedPaths: readonly string[] }): void;
}

export type FileTreeExpansionSnapshot = "collapsed" | "empty" | "expanded" | "mixed" | "searching";

function isDirectoryItem(
  item: FileTreeExpansionItem | null,
): item is FileTreeExpansionDirectoryItem {
  return item?.isDirectory() === true;
}

export function directoryTreePaths(entries: readonly ProjectEntry[]): string[] {
  return [
    ...new Set(
      entries
        .filter((entry) => entry.kind === "directory")
        .map((entry) => `${entry.path.replace(/\/$/, "")}/`),
    ),
  ].sort((left, right) => left.split("/").length - right.split("/").length);
}

export function initiallyExpandedDirectoryPaths(directoryPaths: readonly string[]): string[] {
  return directoryPaths.filter((path) => path.split("/").filter(Boolean).length <= 1);
}

export function getFileTreeExpansionSnapshot(
  model: FileTreeExpansionModel,
  directoryPaths: readonly string[],
): FileTreeExpansionSnapshot {
  if (model.isSearchOpen()) return "searching";

  let hasCollapsedDirectory = false;
  let hasExpandedDirectory = false;
  for (const path of directoryPaths) {
    const item = model.getItem(path);
    if (!isDirectoryItem(item)) continue;
    if (item.isExpanded()) {
      hasExpandedDirectory = true;
    } else {
      hasCollapsedDirectory = true;
    }
    if (hasCollapsedDirectory && hasExpandedDirectory) return "mixed";
  }

  if (hasExpandedDirectory) return "expanded";
  if (hasCollapsedDirectory) return "collapsed";
  return "empty";
}

export function setAllDirectoriesExpanded(
  model: FileTreeExpansionModel,
  treePaths: readonly string[],
  directoryPaths: readonly string[],
  expanded: boolean,
): void {
  if (model.isSearchOpen()) return;
  const snapshot = getFileTreeExpansionSnapshot(model, directoryPaths);
  if (
    snapshot === "empty" ||
    snapshot === "searching" ||
    (expanded ? snapshot === "expanded" : snapshot === "collapsed")
  ) {
    return;
  }

  model.resetPaths(treePaths, {
    initialExpandedPaths: expanded ? directoryPaths : [],
  });
}
