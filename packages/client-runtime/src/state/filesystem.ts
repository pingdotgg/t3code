import { type FilesystemBrowseEntry, WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  canNavigateUp,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  hasTrailingPathSeparator,
  isFilesystemBrowseQuery,
} from "./projects.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function getFilesystemBrowsePath(query: string, platform = "", enabled = true) {
  const isBrowsing = enabled && isFilesystemBrowseQuery(query, platform);
  const directoryPath = isBrowsing ? getBrowseDirectoryPath(query) : "";
  const filterQuery =
    isBrowsing && !hasTrailingPathSeparator(query) ? getBrowseLeafPathSegment(query) : "";
  const parentPath = isBrowsing ? getBrowseParentPath(directoryPath) : null;

  return {
    isBrowsing,
    directoryPath,
    filterQuery,
    parentPath,
    canBrowseUp: isBrowsing && canNavigateUp(directoryPath),
  };
}

export function filterFilesystemBrowseEntries(
  entries: ReadonlyArray<FilesystemBrowseEntry>,
  query: string,
) {
  const lowerQuery = query.toLowerCase();
  const showHidden = query.startsWith(".");
  const visibleEntries = entries.filter(
    (entry) =>
      entry.name.toLowerCase().startsWith(lowerQuery) &&
      (showHidden || !entry.name.startsWith(".")),
  );
  const exactEntry =
    query.length > 0 ? (visibleEntries.find((entry) => entry.name === query) ?? null) : null;

  return { visibleEntries, exactEntry };
}

/**
 * A folder the picker may create: one new child of the directory it is showing.
 * Names carrying separators or dot segments belong to a path the user is still
 * typing, not to a folder we should offer to create.
 */
function isCreatableDirectoryName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed !== "." && trimmed !== ".." && !/[\\/]/.test(trimmed);
}

/**
 * The create-folder target for a browse query, or null when there is nothing to
 * create: no name typed, an unusable name, or a folder of that name already in
 * the listing. `entries` must be the loaded listing for `directoryPath`, so a
 * pending listing never offers to create a folder that already exists.
 */
export function getBrowseCreateDirectoryTarget(input: {
  readonly directoryPath: string;
  readonly leafName: string;
  readonly entries: ReadonlyArray<FilesystemBrowseEntry>;
  readonly caseSensitive: boolean;
}): { readonly parentPath: string; readonly name: string } | null {
  const name = input.leafName.trim();
  if (input.directoryPath.length === 0 || !isCreatableDirectoryName(name)) {
    return null;
  }

  const lowerName = name.toLowerCase();
  const exists = input.entries.some((entry) =>
    input.caseSensitive ? entry.name === name : entry.name.toLowerCase() === lowerName,
  );
  return exists ? null : { parentPath: input.directoryPath, name };
}

export function createBrowseNavigationCoordinator() {
  let generation = 0;

  return {
    invalidate: () => {
      generation += 1;
    },
    run: async (load: () => Promise<void>, commit: () => void) => {
      const navigationGeneration = ++generation;
      await load();
      if (navigationGeneration !== generation) {
        return false;
      }
      commit();
      return true;
    },
  };
}

export function canPreloadBrowsePath(
  connectionPhase: EnvironmentConnectionPhase | null | undefined,
): boolean {
  return connectionPhase === "connected";
}

export function createFilesystemEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    browse: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:filesystem:browse",
      tag: WS_METHODS.filesystemBrowse,
    }),
    createDirectory: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:filesystem:create-directory",
      tag: WS_METHODS.filesystemCreateDirectory,
    }),
  };
}
