import {
  AuthFilesystemReadScope,
  type FilesystemBrowseEntry,
  WS_METHODS,
  sessionGrantsScope,
  type SessionGrantInput,
} from "@t3tools/contracts";
import { scoreQueryMatch } from "@t3tools/shared/searchRanking";
import { Atom } from "effect/reactivity";

import type {
  EnvironmentConnectionPhase,
  EnvironmentConnectionPresentation,
} from "../connection/presentation.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  canNavigateUp,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  hasTrailingPathSeparator,
  isFilesystemBrowseQuery,
} from "./projects.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

const BROWSE_IDLE_TTL_MS = 5_000;

export function resolveFilesystemReadAccess(input: {
  readonly isCatalogReady: boolean;
  readonly connection: Pick<EnvironmentConnectionPresentation, "phase" | "error"> | null;
  readonly session: SessionGrantInput | null;
  readonly sessionError: string | null;
}) {
  if (input.sessionError !== null) {
    return { canReadFiles: false, isPending: false, error: input.sessionError };
  }
  if (input.session === null) {
    // Wait for the catalog before interpreting a missing presentation as offline.
    // Once ready, an offline environment cannot finish its session check.
    const isPending =
      !input.isCatalogReady ||
      input.connection?.phase === "connected" ||
      input.connection?.phase === "connecting" ||
      input.connection?.phase === "reconnecting";
    return {
      canReadFiles: false,
      isPending,
      error: isPending ? null : (input.connection?.error ?? "This environment is not connected."),
    };
  }
  return {
    canReadFiles: sessionGrantsScope(input.session, AuthFilesystemReadScope),
    isPending: false,
    error: null,
  };
}

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
  const candidates = entries.filter((entry) => showHidden || !entry.name.startsWith("."));
  const visibleEntries =
    lowerQuery.length === 0
      ? candidates
      : candidates
          .map((entry) => ({
            entry,
            // Position penalties stay under 1000 for 255-character names, so tiers never overlap.
            score: scoreQueryMatch({
              value: entry.name.toLowerCase(),
              query: lowerQuery,
              exactBase: 0,
              prefixBase: 1000,
              boundaryBase: 2000,
              includesBase: 3000,
              fuzzyBase: 4000,
              boundaryMarkers: [" ", "-", "_", "."],
            }),
          }))
          .filter((match): match is { entry: FilesystemBrowseEntry; score: number } => {
            return match.score !== null;
          })
          .sort((left, right) => left.score - right.score)
          .map((match) => match.entry);
  const exactEntry =
    query.length > 0 ? (visibleEntries.find((entry) => entry.name === query) ?? null) : null;

  return { visibleEntries, exactEntry };
}

/** Shell-style Tab: a single match enters the directory, several extend to their common prefix. */
export function getFilesystemBrowseTabCompletion(
  visibleEntries: ReadonlyArray<FilesystemBrowseEntry>,
  filterQuery: string,
): { readonly name: string; readonly isComplete: boolean } | null {
  const [first, ...rest] = visibleEntries;
  if (first === undefined) return null;
  if (rest.length === 0) return { name: first.name, isComplete: true };
  let prefix = Array.from(first.name);
  for (const entry of rest) {
    const characters = Array.from(entry.name);
    let length = 0;
    while (
      length < prefix.length &&
      prefix[length]?.toLowerCase() === characters[length]?.toLowerCase()
    )
      length += 1;
    prefix = prefix.slice(0, length);
  }
  const name = prefix.join("");
  const lowerName = name.toLowerCase();
  return lowerName.length > filterQuery.toLowerCase().length &&
    visibleEntries.every((entry) => entry.name.toLowerCase().startsWith(lowerName))
    ? { name, isComplete: false }
    : null;
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
    getMetadata: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:filesystem:get-metadata",
      tag: WS_METHODS.filesystemGetMetadata,
    }),
    browse: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:filesystem:browse",
      tag: WS_METHODS.filesystemBrowse,
      // A listing kept alive while unread is never revalidated, so reopening the browser
      // would show folders as they were. Keep it only long enough for a prefetch to land.
      idleTtlMs: BROWSE_IDLE_TTL_MS,
    }),
  };
}
