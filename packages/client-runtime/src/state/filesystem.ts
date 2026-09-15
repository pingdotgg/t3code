import { type FilesystemBrowseEntry, WS_METHODS } from "@t3tools/contracts";
import { scoreDirectoryMatch } from "@t3tools/shared/searchRanking";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  canNavigateUp,
  ensureBrowseDirectoryPath,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  hasTrailingPathSeparator,
  isFilesystemBrowseQuery,
  isUnsupportedWindowsProjectPath,
} from "./projects.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function getFilesystemBrowsePath(
  query: string,
  platform = "",
  enabled = true,
  baseDirectory = "",
) {
  if (
    baseDirectory &&
    query &&
    !isFilesystemBrowseQuery(query, platform) &&
    !isUnsupportedWindowsProjectPath(query, platform)
  ) {
    query = `${ensureBrowseDirectoryPath(baseDirectory)}${query}`;
  }
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
  const showHidden = query.startsWith(".");
  const visibleEntries = entries
    .flatMap((entry) => {
      if (!showHidden && entry.name.startsWith(".")) return [];
      const score =
        entry.searchMatch?.query === query
          ? entry.searchMatch.score
          : scoreDirectoryMatch(entry.name, query);
      return score === null ? [] : [{ entry, score }];
    })
    .sort((left, right) => left.score - right.score)
    .map(({ entry }) => entry);
  const exactEntry =
    query.length > 0
      ? (visibleEntries.find((entry) => !entry.searchMatch && entry.name === query) ?? null)
      : null;

  return { visibleEntries, exactEntry };
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
  };
}
