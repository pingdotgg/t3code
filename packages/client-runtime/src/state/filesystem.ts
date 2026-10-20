import {
  AuthFilesystemReadScope,
  type AuthSessionState,
  type FilesystemBrowseEntry,
  WS_METHODS,
  sessionGrantsScope,
  type SessionGrantInput,
} from "@t3tools/contracts";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

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
  const visibleEntries = entries.filter(
    (entry) =>
      entry.name.toLowerCase().startsWith(lowerQuery) &&
      (showHidden || !entry.name.startsWith(".")),
  );
  const exactEntry =
    query.length > 0 ? (visibleEntries.find((entry) => entry.name === query) ?? null) : null;

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

export function createFilesystemBrowseSession<T, A, E>(
  browse: (target: T) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) {
  const family = Atom.family((source: Atom.Atom<AsyncResult.AsyncResult<A, E>>) => {
    const visited = new WeakSet<AtomRegistry.AtomRegistry>();
    return Atom.transform(source, (get) => {
      // Idle-TTL nodes outlive the picker without remounting SWR. Check before
      // reading so a synchronous cold load isn't mistaken for cached data.
      const cached = get.registry.getNodes().get(source)?.currentState() === "valid";
      const result = get.once(source);
      if (!visited.has(get.registry)) {
        visited.add(get.registry);
        if (cached && !result.waiting && !AsyncResult.isInitial(result)) {
          get.refresh(source);
        }
      }
      get.subscribe(source, (value) => get.setSelf(value));
      return get.once(source);
    });
  });
  return (target: T) => family(browse(target));
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
    }),
  };
}
