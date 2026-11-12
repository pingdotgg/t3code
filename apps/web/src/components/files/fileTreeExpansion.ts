import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";

export interface FileTreeExpansionModel {
  getItem(path: string): unknown;
}

type DirectoryHandle = {
  isDirectory(): boolean;
  isExpanded(): boolean;
  expand(): void;
  collapse(): void;
};

function asDirectoryHandle(item: unknown): DirectoryHandle | null {
  if (
    typeof item !== "object" ||
    item === null ||
    !("isDirectory" in item) ||
    typeof item.isDirectory !== "function" ||
    !item.isDirectory() ||
    !("isExpanded" in item) ||
    typeof item.isExpanded !== "function" ||
    !("expand" in item) ||
    typeof item.expand !== "function" ||
    !("collapse" in item) ||
    typeof item.collapse !== "function"
  ) {
    return null;
  }
  return item as DirectoryHandle;
}

export function areAllDirectoriesExpanded(
  model: FileTreeExpansionModel,
  directoryPaths: readonly string[],
): boolean {
  return (
    directoryPaths.length > 0 &&
    directoryPaths.every((path) => {
      const item = asDirectoryHandle(model.getItem(path));
      return item !== null && item.isExpanded();
    })
  );
}

export function setAllDirectoriesExpanded(
  model: FileTreeExpansionModel,
  directoryPaths: readonly string[],
  expanded: boolean,
): void {
  for (const path of directoryPaths) {
    const item = asDirectoryHandle(model.getItem(path));
    if (item === null || item.isExpanded() === expanded) continue;
    if (expanded) item.expand();
    else item.collapse();
  }
}

/** Calls made while `run` is running rerun it once it returns, instead of nesting. */
export function coalesceReentrantCalls(run: () => void): () => void {
  let running = false;
  let calledAgain = false;
  return () => {
    if (running) {
      calledAgain = true;
      return;
    }
    running = true;
    try {
      do {
        calledAgain = false;
        run();
      } while (calledAgain);
    } finally {
      running = false;
    }
  };
}

const EXPANDED_DIRECTORIES_STORAGE_KEY = "t3code.fileTreeExpandedDirectories";
// Roots are kept most recent first and capped so worktrees that come and go do not grow storage.
const MAX_STORED_ROOTS = 20;
const StoredExpandedDirectories = Schema.Array(
  Schema.Struct({ root: Schema.String, paths: Schema.Array(Schema.String) }),
);

function readStoredExpandedDirectories() {
  try {
    return getLocalStorageItem(EXPANDED_DIRECTORIES_STORAGE_KEY, StoredExpandedDirectories) ?? [];
  } catch (error) {
    console.error(error);
    return [];
  }
}

export function readExpandedDirectories(root: string): readonly string[] {
  return readStoredExpandedDirectories().find((entry) => entry.root === root)?.paths ?? [];
}

export function writeExpandedDirectories(root: string, paths: readonly string[]): void {
  const others = readStoredExpandedDirectories().filter((entry) => entry.root !== root);
  const next = paths.length > 0 ? [{ root, paths }, ...others] : others;
  try {
    setLocalStorageItem(
      EXPANDED_DIRECTORIES_STORAGE_KEY,
      next.slice(0, MAX_STORED_ROOTS),
      StoredExpandedDirectories,
    );
  } catch (error) {
    console.error(error);
  }
}
