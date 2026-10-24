import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { ProjectListEntriesError, type EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";

function createDirectories() {
  return {
    target: {},
    entries: new Map<string, ReadonlyArray<ProjectEntry>>(),
    errors: new Map<string, string>(),
    completeDirectories: new Set<string>(),
    listingCompletedAt: new Map<string, number>(),
    discoveries: new Map<string, ProjectEntry>(),
    rootListing: null as { readonly timestamp: number } | null,
    validatedDirectories: new Set<string>(),
    loading: new Set<string>(),
    expandedPaths: new Set<string>(),
    selectedPath: null as string | null,
    revealedSelection: { path: null as string | null, ancestors: new Set<string>() },
    isRefreshing: false,
  };
}

function boundDirectories(current: ReturnType<typeof createDirectories>, preserveVisible = true) {
  const visible = (path: string) => {
    const parts = path.split("/");
    return parts.every((_, index) =>
      current.expandedPaths.has(parts.slice(0, index + 1).join("/")),
    );
  };
  const inactive = [
    ...new Set([...current.entries.keys(), ...current.errors.keys(), ...current.expandedPaths]),
  ].filter((path) => !preserveVisible || !visible(path));
  const ownedPaths = [
    ...current.entries.keys(),
    ...current.expandedPaths,
    current.selectedPath,
  ].filter((path) => path !== null);
  const discoveries = new Map(
    [...current.discoveries].filter(([path]) =>
      ownedPaths.some((owned) => owned === path || owned.startsWith(`${path}/`)),
    ),
  );
  if (inactive.length <= 64)
    return discoveries.size === current.discoveries.size ? current : { ...current, discoveries };
  const evicted = new Set(inactive.slice(0, -64));
  const isEvicted = (path: string) => {
    const parts = path.split("/");
    return parts.some((_, index) => evicted.has(parts.slice(0, index + 1).join("/")));
  };
  return {
    ...current,
    discoveries: new Map([...discoveries].filter(([path]) => !isEvicted(path))),
    expandedPaths: new Set([...current.expandedPaths].filter((path) => !isEvicted(path))),
    entries: new Map([...current.entries].filter(([path]) => !isEvicted(path))),
    errors: new Map([...current.errors].filter(([path]) => !isEvicted(path))),
    completeDirectories: new Set(
      [...current.completeDirectories].filter((path) => !isEvicted(path)),
    ),
    validatedDirectories: new Set(
      [...current.validatedDirectories].filter((path) => !isEvicted(path)),
    ),
    listingCompletedAt: new Map(
      [...current.listingCompletedAt].filter(([path]) => !isEvicted(path)),
    ),
  };
}

function contradictsListing(path: string, parent: string, entries: ReadonlyArray<ProjectEntry>) {
  if (parent !== "" && !path.startsWith(`${parent}/`)) return false;
  const child = path.slice(parent === "" ? 0 : parent.length + 1).split("/")[0];
  const childPath = parent === "" ? child : `${parent}/${child}`;
  const entry = entries.find((item) => item.path === childPath);
  return !entry || (path !== childPath && entry.kind !== "directory");
}

function createRequests() {
  return {
    active: true,
    refreshVersion: 0,
    pending: new Map<string, AbortController>(),
  };
}

function getRequests(
  requestsByTarget: WeakMap<object, ReturnType<typeof createRequests>>,
  target: object,
) {
  let requests = requestsByTarget.get(target);
  if (!requests) {
    requests = createRequests();
    requestsByTarget.set(target, requests);
  }
  return requests;
}

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
  const { refresh: refreshRoot } = root;
  const search = useEnvironmentQuery(
    searching && debouncedQuery.length > 0 && cwd !== null && environmentId !== null
      ? projectEnvironment.searchEntries({
          environmentId,
          input: { cwd, query: debouncedQuery, limit: 200 },
        })
      : null,
  );
  const workspaceKey = JSON.stringify([environmentId, cwd]);
  const [cache, setCache] = useState(() => ({
    key: workspaceKey,
    workspaces: new Map([[workspaceKey, createDirectories()]]),
  }));
  const savedDirectories = cache.workspaces.get(workspaceKey) ?? createDirectories();
  // Requests belong to a visit, so returning cannot revive an old completion.
  const directories =
    cache.key === workspaceKey
      ? savedDirectories
      : {
          ...savedDirectories,
          target: {},
          validatedDirectories: new Set<string>(),
          errors: new Map<string, string>(),
          loading: new Set<string>(),
          isRefreshing: false,
        };
  if (cache.key !== workspaceKey) {
    const workspaces = new Map(cache.workspaces);
    const previous = workspaces.get(cache.key);
    if (previous) {
      workspaces.set(
        cache.key,
        boundDirectories(
          {
            ...previous,
            errors: new Map(),
            loading: new Set(),
            isRefreshing: false,
          },
          false,
        ),
      );
    }
    workspaces.delete(workspaceKey);
    workspaces.set(workspaceKey, directories);
    if (workspaces.size > 8) workspaces.delete(workspaces.keys().next().value!);
    setCache({ key: workspaceKey, workspaces });
  }
  const setDirectories = useCallback(
    (
      update: (
        current: ReturnType<typeof createDirectories>,
      ) => ReturnType<typeof createDirectories>,
    ) =>
      setCache((current) => {
        const previous = current.workspaces.get(workspaceKey);
        if (!previous) return current;
        const next = boundDirectories(update(previous));
        if (next === previous) return current;
        return { ...current, workspaces: new Map(current.workspaces).set(workspaceKey, next) };
      }),
    [workspaceKey],
  );
  const { target } = directories;
  const requestsByTarget = useRef(new WeakMap<object, ReturnType<typeof createRequests>>());
  // Cancel the old target before consumers' passive effects start new directory loads.
  useLayoutEffect(() => {
    const requests = getRequests(requestsByTarget.current, target);
    requests.active = true;
    refreshRoot();
    return () => {
      requests.active = false;
      requests.refreshVersion++;
      for (const controller of requests.pending.values()) controller.abort();
      requests.pending.clear();
      setDirectories((current) =>
        current.target === target
          ? { ...current, loading: new Set(), isRefreshing: false }
          : current,
      );
    };
  }, [target, setDirectories, requestsByTarget, refreshRoot]);
  const updateDirectories = (
    update: (current: ReturnType<typeof createDirectories>) => ReturnType<typeof createDirectories>,
  ) => setDirectories((current) => (current.target === target ? update(current) : current));
  const loadDirectory = (directoryPath: string, refresh = false) => {
    const requests = getRequests(requestsByTarget.current, target);
    if (
      !requests.active ||
      missingRoot ||
      cwd === null ||
      environmentId === null ||
      (!refresh && directories.validatedDirectories.has(directoryPath)) ||
      requests.pending.has(directoryPath)
    ) {
      return;
    }
    const controller = new AbortController();
    requests.pending.set(directoryPath, controller);
    updateDirectories((current) => {
      const errors = new Map(current.errors);
      errors.delete(directoryPath);
      return { ...current, errors, loading: new Set(current.loading).add(directoryPath) };
    });
    const atom = projectEnvironment.listEntries({ environmentId, input: { cwd, directoryPath } });
    appAtomRegistry.refresh(atom);
    return executeAtomQuery(appAtomRegistry, atom, {
      signal: controller.signal,
      reportFailure: false,
      reportDefect: false,
    }).then((result) => {
      if (controller.signal.aborted) return;
      requests.pending.delete(directoryPath);
      updateDirectories((current) => {
        const validatedDirectories = new Set(current.validatedDirectories).add(directoryPath);
        const loading = new Set(current.loading);
        loading.delete(directoryPath);
        if (result._tag === "Success") {
          const entries = new Map(current.entries);
          entries.delete(directoryPath);
          entries.set(
            directoryPath,
            result.value.entries.filter(
              (entry) =>
                entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) === directoryPath,
            ),
          );
          const completeDirectories = new Set(current.completeDirectories);
          if (result.value.truncated) completeDirectories.delete(directoryPath);
          else completeDirectories.add(directoryPath);
          return {
            ...current,
            entries,
            loading,
            completeDirectories,
            discoveries: result.value.truncated
              ? current.discoveries
              : new Map(
                  [...current.discoveries].filter(
                    ([path]) => !contradictsListing(path, directoryPath, result.value.entries),
                  ),
                ),
            validatedDirectories,
            listingCompletedAt: new Map(current.listingCompletedAt).set(
              directoryPath,
              result.timestamp,
            ),
          };
        }
        const error = Cause.squash(result.cause);
        return {
          ...current,
          loading,
          validatedDirectories,
          errors: new Map(current.errors).set(
            directoryPath,
            error instanceof Error ? error.message : "Files unavailable",
          ),
        };
      });
    });
  };
  const missingRoot =
    root.failure instanceof ProjectListEntriesError &&
    root.failure.failure === "workspace_root_not_found";
  const rootData = missingRoot ? null : root.data;
  const rootListing = root.successResult ?? directories.rootListing;
  if (
    missingRoot &&
    (directories.entries.size > 0 ||
      directories.errors.size > 0 ||
      directories.loading.size > 0 ||
      directories.expandedPaths.size > 0 ||
      directories.selectedPath !== null ||
      directories.discoveries.size > 0)
  ) {
    setDirectories(() => createDirectories());
  }
  const { refresh: refreshSearch, data: searchData, successResult: searchResult } = search;
  const snapshot = (() => {
    const merged = new Map(missingRoot ? [] : directories.discoveries);
    if (searching && !missingRoot) {
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
    if (!missingRoot) visit([...directories.discoveries.values()]);
    visit((rootData?.entries ?? []).filter((entry) => !entry.path.includes("/")));
    return {
      entries: [...merged.values()],
      reachableDirectories,
      searchResultPaths:
        searching && !missingRoot
          ? new Set((searchData?.entries ?? []).map((entry) => entry.path))
          : null,
    };
  })();

  if (rootData) {
    const deleted = (path: string, directory = false) => {
      const parts = path.split("/");
      for (let index = 0; index < parts.length; index++) {
        const parent = parts.slice(0, index).join("/");
        const listing = index === 0 ? rootData.entries : directories.entries.get(parent);
        const child = parts.slice(0, index + 1).join("/");
        const complete =
          index === 0 ? !rootData.truncated : directories.completeDirectories.has(parent);
        const entry = listing?.find((item) => item.path === child);
        if (complete && listing && !entry) {
          const listingCompletedAt =
            index === 0 && directories.rootListing !== rootListing
              ? rootListing?.timestamp
              : directories.listingCompletedAt.get(parent);
          // Cached queries keep their completion time across query switches.
          // Equal-millisecond responses cannot prove a path postdates the listing.
          const retained =
            !(index === 0 && directories.rootListing !== rootListing) &&
            [...directories.discoveries.keys()].some(
              (path) => path === child || path.startsWith(`${child}/`),
            );
          const discovered =
            retained ||
            (searching &&
              query === debouncedQuery &&
              searchResult !== null &&
              searchResult.timestamp > (listingCompletedAt ?? -Infinity) &&
              searchData?.entries.some(
                (item) => item.path === child || item.path.startsWith(`${child}/`),
              ));
          if (!discovered) return true;
        }
        if (entry && (directory || index < parts.length - 1) && entry.kind !== "directory")
          return true;
      }
      return false;
    };
    const reconciled = (() => {
      const current = directories;
      const discoveries = new Map(current.discoveries);
      if (current.rootListing !== rootListing && !rootData.truncated) {
        for (const path of discoveries.keys()) {
          if (contradictsListing(path, "", rootData.entries)) discoveries.delete(path);
        }
      }
      if (searching && query === debouncedQuery && searchResult !== null) {
        const ownedPaths = [
          ...current.entries.keys(),
          ...current.expandedPaths,
          current.selectedPath,
        ];
        for (const entry of searchData?.entries ?? []) {
          if (
            ownedPaths.some((path) => path === entry.path || path?.startsWith(`${entry.path}/`)) &&
            !deleted(entry.path, entry.kind === "directory")
          )
            discoveries.set(entry.path, entry);
        }
      }
      const entries = new Map([...current.entries].filter(([path]) => !deleted(path, true)));
      const errors = new Map([...current.errors].filter(([path]) => !deleted(path, true)));
      const expandedPaths = new Set(
        [...current.expandedPaths].filter((path) => !deleted(path, true)),
      );
      const selectedPath =
        current.selectedPath !== null && deleted(current.selectedPath)
          ? null
          : current.selectedPath;
      if (
        entries.size === current.entries.size &&
        errors.size === current.errors.size &&
        expandedPaths.size === current.expandedPaths.size &&
        selectedPath === current.selectedPath &&
        current.rootListing === rootListing &&
        discoveries.size === current.discoveries.size &&
        [...discoveries].every(([path, entry]) => current.discoveries.get(path) === entry)
      )
        return current;
      const completeDirectories = new Set(
        [...current.completeDirectories].filter((path) => entries.has(path)),
      );
      return {
        ...current,
        rootListing,
        discoveries,
        listingCompletedAt: new Map(
          [...current.listingCompletedAt].filter(([path]) => path === "" || entries.has(path)),
        ).set(
          "",
          current.rootListing === rootListing
            ? (current.listingCompletedAt.get("") ?? -Infinity)
            : (rootListing?.timestamp ?? -Infinity),
        ),
        entries,
        errors,
        expandedPaths,
        selectedPath,
        completeDirectories,
        validatedDirectories: new Set(
          [...current.validatedDirectories].filter((path) => !deleted(path, true)),
        ),
      };
    })();
    if (reconciled !== directories) setDirectories(() => reconciled);
  }

  const refresh = () => {
    const requests = getRequests(requestsByTarget.current, target);
    if (!requests.active) return Promise.resolve();
    refreshRoot();
    if (searching && !missingRoot) refreshSearch();
    const paths = new Set(
      [...directories.entries.keys(), ...directories.errors.keys(), ...directories.loading].filter(
        (path) => snapshot.reachableDirectories.has(path),
      ),
    );
    for (const controller of requests.pending.values()) controller.abort();
    requests.pending.clear();
    const version = ++requests.refreshVersion;
    updateDirectories((current) => ({
      ...current,
      errors: new Map(),
      loading: new Set(),
      isRefreshing: true,
    }));
    const remaining = paths.values();
    const worker = async () => {
      while (requests.active && version === requests.refreshVersion) {
        const next = remaining.next();
        if (next.done) return;
        await loadDirectory(next.value, true);
      }
    };
    const queries =
      cwd !== null && environmentId !== null
        ? [
            projectEnvironment.listEntries({ environmentId, input: { cwd, directoryPath: "" } }),
            ...(searching && !missingRoot
              ? [
                  projectEnvironment.searchEntries({
                    environmentId,
                    input: { cwd, query: debouncedQuery, limit: 200 },
                  }),
                ]
              : []),
          ]
        : [];
    const work = [
      ...queries.map((atom) =>
        executeAtomQuery(appAtomRegistry, atom, { reportFailure: false, reportDefect: false }),
      ),
      ...Array.from({ length: Math.min(4, paths.size) }, () => worker()),
    ];
    return Promise.all(work).finally(() => {
      if (version === requests.refreshVersion) {
        updateDirectories((current) => ({ ...current, isRefreshing: false }));
      }
    });
  };

  const revealSelection = (path: string | null) => {
    if (missingRoot) return;
    updateDirectories((current) => {
      const previous = current.revealedSelection;
      const handled = previous.path === path ? previous.ancestors : new Set<string>();
      const parts = path?.split("/").filter(Boolean) ?? [];
      const ancestors = parts
        .slice(1)
        .map((_, index) => parts.slice(0, index + 1).join("/"))
        .filter(
          (ancestor) =>
            !handled.has(ancestor) &&
            snapshot.entries.some((entry) => entry.kind === "directory" && entry.path === ancestor),
        );
      if (previous.path === path && ancestors.length === 0) return current;
      return {
        ...current,
        revealedSelection: { path, ancestors: new Set([...handled, ...ancestors]) },
        expandedPaths: new Set([...current.expandedPaths, ...ancestors]),
      };
    });
  };

  const setExpandedPaths = useCallback(
    (update: (current: ReadonlySet<string>) => ReadonlySet<string>) =>
      setDirectories((current) => {
        const expandedPaths = update(current.expandedPaths);
        return expandedPaths === current.expandedPaths
          ? current
          : { ...current, expandedPaths: new Set(expandedPaths) };
      }),
    [setDirectories],
  );

  return {
    revealSelection,
    expandedPaths: directories.expandedPaths,
    setExpandedPaths,
    selectedPath: directories.selectedPath,
    selectPath: (selectedPath: string) =>
      updateDirectories((current) => ({ ...current, selectedPath })),
    entries: snapshot.entries,
    searchResultPaths: snapshot.searchResultPaths,
    isRefreshing: directories.isRefreshing,
    error:
      root.error ??
      (searching ? search.error : null) ??
      [...directories.errors].find(([path]) => snapshot.reachableDirectories.has(path))?.[1] ??
      null,
    isPending:
      !missingRoot &&
      (root.isPending ||
        directories.loading.size > 0 ||
        (searching && (query !== debouncedQuery || search.isPending))),
    searchTruncated: !missingRoot && searching && (search.data?.truncated ?? false),
    loadedDirectories: new Set(directories.entries.keys()),
    loadingDirectories: directories.loading,
    loadDirectory,
    refresh,
  };
}
