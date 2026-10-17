import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "~/hooks/useLocalStorage";

import { asDirectoryHandle, type FileTreeExpansionModel } from "./fileTreeExpansion";

/** Bounds what a huge "expand all" can write; shallow folders win so restore still reaches them. */
const MAX_PERSISTED_EXPANDED_PATHS = 500;

const ExpandedPathsSchema = Schema.Array(Schema.String);

/** Expansion is workspace-scoped, like the tree itself, not per thread. */
export function fileTreeExpansionStorageKey(environmentId: EnvironmentId, cwd: string): string {
  return `t3code.fileTreeExpanded:${environmentId}:${cwd}`;
}

/** Expanded directory paths without the trailing slash; unreadable storage restores nothing. */
export function readExpandedPaths(storageKey: string): Set<string> {
  try {
    return new Set(getLocalStorageItem(storageKey, ExpandedPathsSchema) ?? []);
  } catch {
    return new Set();
  }
}

export function writeExpandedPaths(storageKey: string, paths: ReadonlySet<string>): void {
  try {
    if (paths.size === 0) {
      removeLocalStorageItem(storageKey);
      return;
    }
    const depth = (path: string) => path.split("/").length;
    const bounded = [...paths]
      .toSorted((a, b) => depth(a) - depth(b))
      .slice(0, MAX_PERSISTED_EXPANDED_PATHS);
    setLocalStorageItem(storageKey, bounded, ExpandedPathsSchema);
  } catch {
    // Remembering folders is a convenience; a full or blocked storage must not break the tree.
  }
}

function parentDirectory(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

/**
 * Reconciles the remembered folders with the tree rows. `persisted` is the set
 * to store; `pendingRestore` holds remembered folders whose row has not
 * appeared yet. Rows only exist once their parent is listed, so expanding each
 * as it appears restores parent-before-child. A folder is forgotten when it is
 * collapsed or when its parent was listed and no longer has it. Returns whether
 * `persisted` changed.
 */
export function syncPersistedExpansion(args: {
  readonly model: FileTreeExpansionModel;
  /** Tree paths of known directories, with the trailing slash. */
  readonly directoryPaths: readonly string[];
  /** Directories whose listing succeeded. */
  readonly loadedDirectories: ReadonlySet<string>;
  readonly persisted: Set<string>;
  readonly pendingRestore: Set<string>;
}): boolean {
  const { model, directoryPaths, loadedDirectories, persisted, pendingRestore } = args;
  const knownDirectories = new Set<string>();
  let changed = false;
  for (const treePath of directoryPaths) {
    const path = treePath.slice(0, -1);
    knownDirectories.add(path);
    const item = asDirectoryHandle(model.getItem(treePath));
    if (item === null) continue;
    if (pendingRestore.delete(path) && !item.isExpanded()) item.expand();
    if (item.isExpanded()) {
      if (!persisted.has(path)) {
        persisted.add(path);
        changed = true;
      }
    } else if (persisted.delete(path)) {
      changed = true;
    }
  }
  for (const path of persisted) {
    if (knownDirectories.has(path) || !loadedDirectories.has(parentDirectory(path))) continue;
    persisted.delete(path);
    pendingRestore.delete(path);
    changed = true;
  }
  return changed;
}
