import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";

export function useFileTreeEntries(input: {
  readonly cwd: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly searchQuery: string;
}) {
  const { cwd, environmentId } = input;
  const searching = input.searchQuery.trim().length > 0;
  const query = input.searchQuery.trim().slice(0, 256);
  const debouncedQuery = useDebouncedValue(query, 200);
  const root = useEnvironmentQuery(
    cwd !== null && environmentId !== null
      ? projectEnvironment.listEntries({ environmentId, input: { cwd, directoryPath: "" } })
      : null,
  );
  const search = useEnvironmentQuery(
    searching && debouncedQuery.length > 0 && cwd !== null && environmentId !== null
      ? projectEnvironment.searchEntries({
          environmentId,
          input: { cwd, query: debouncedQuery, limit: 200 },
        })
      : null,
  );
  const [revision, render] = useReducer((value: number) => value + 1, 0);
  const refreshVersion = useRef(0);
  const directories = useMemo(
    () => ({
      cwd,
      environmentId,
      entries: new Map<string, ReadonlyArray<ProjectEntry>>(),
      requested: new Set<string>(),
      pending: new Map<string, AbortController>(),
      errors: new Map<string, string>(),
    }),
    [cwd, environmentId],
  );
  useEffect(
    () => () => {
      refreshVersion.current++;
      for (const controller of directories.pending.values()) controller.abort();
      directories.pending.clear();
    },
    [directories],
  );
  const loadDirectory = useCallback(
    (directoryPath: string, refresh = false) => {
      if (
        cwd === null ||
        environmentId === null ||
        (!refresh && directories.entries.has(directoryPath)) ||
        directories.pending.has(directoryPath)
      ) {
        return;
      }
      const controller = new AbortController();
      directories.requested.add(directoryPath);
      directories.pending.set(directoryPath, controller);
      directories.errors.delete(directoryPath);
      render();
      const atom = projectEnvironment.listEntries({ environmentId, input: { cwd, directoryPath } });
      appAtomRegistry.refresh(atom);
      return executeAtomQuery(appAtomRegistry, atom, {
        signal: controller.signal,
        reportFailure: false,
        reportDefect: false,
      }).then((result) => {
        if (controller.signal.aborted) return;
        directories.pending.delete(directoryPath);
        if (result._tag === "Success") {
          directories.entries.set(
            directoryPath,
            result.value.entries.filter(
              (entry) =>
                entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) === directoryPath,
            ),
          );
        } else {
          const error = Cause.squash(result.cause);
          directories.errors.set(
            directoryPath,
            error instanceof Error ? error.message : "Files unavailable",
          );
        }
        render();
      });
    },
    [cwd, directories, environmentId],
  );
  const { refresh: refreshRoot, data: rootData } = root;
  const { refresh: refreshSearch, data: searchData } = search;
  const snapshot = useMemo(() => {
    const merged = new Map<string, ProjectEntry>();
    if (searching) {
      for (const entry of searchData?.entries ?? []) merged.set(entry.path, entry);
    }
    const reachableDirectories = new Set<string>();
    const visit = (items: ReadonlyArray<ProjectEntry>) => {
      for (const entry of items) {
        merged.set(entry.path, entry);
        if (entry.kind === "directory") {
          reachableDirectories.add(entry.path);
          visit(directories.entries.get(entry.path) ?? []);
        }
      }
    };
    visit((rootData?.entries ?? []).filter((entry) => !entry.path.includes("/")));
    return { revision, entries: [...merged.values()], reachableDirectories };
  }, [directories, revision, rootData, searchData, searching]);

  const refresh = useCallback(() => {
    refreshRoot();
    if (searching) refreshSearch();
    const paths = new Set(
      [...directories.requested].filter((path) => snapshot.reachableDirectories.has(path)),
    );
    for (const controller of directories.pending.values()) controller.abort();
    directories.pending.clear();
    directories.errors.clear();
    const version = ++refreshVersion.current;
    const remaining = paths.values();
    const worker = async () => {
      while (version === refreshVersion.current) {
        const next = remaining.next();
        if (next.done) return;
        await loadDirectory(next.value, true);
      }
    };
    for (let index = 0; index < Math.min(4, paths.size); index++) void worker();
    render();
  }, [
    directories,
    loadDirectory,
    refreshRoot,
    refreshSearch,
    searching,
    snapshot.reachableDirectories,
  ]);

  return {
    entries: snapshot.entries,
    error:
      root.error ??
      (searching ? search.error : null) ??
      [...directories.errors].find(([path]) => snapshot.reachableDirectories.has(path))?.[1] ??
      null,
    isPending:
      root.isPending ||
      directories.pending.size > 0 ||
      (searching && (query !== debouncedQuery || search.isPending)),
    searchTruncated: searching && (search.data?.truncated ?? false),
    loadedDirectories: new Set(directories.entries.keys()),
    loadDirectory,
    refresh,
  };
}
