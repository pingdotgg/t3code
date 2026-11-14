import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { useAtomMount, useAtomSubscribe } from "@effect/atom-react";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { useEffect, useRef, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

// True when a loaded ancestor's listing no longer holds the folder on the way to `path`.
function isDetached(listings: ReadonlyMap<string, readonly ProjectEntry[]>, path: string) {
  if (path === "") return false;
  const segments = path.split("/");
  return segments.some((_, depth) => {
    const child = segments.slice(0, depth + 1).join("/");
    const listing = listings.get(segments.slice(0, depth).join("/"));
    return listing?.some((entry) => entry.kind === "directory" && entry.path === child) === false;
  });
}

export function useDirectoryEntries(environmentId: EnvironmentId, cwd: string) {
  const [directories, setDirectories] = useState(new Map<string, readonly ProjectEntry[]>());
  const [errors, setErrors] = useState(new Map<string, string>());
  const [pending, setPending] = useState(1);
  const [loadingDirectories, setLoadingDirectories] = useState<ReadonlySet<string>>(
    () => new Set([""]),
  );
  // Source of truth for `directories`, so a listing can purge folders it no longer holds.
  const listings = useRef(new Map<string, readonly ProjectEntry[]>());
  const requests = useRef(new Map<string, Promise<void>>());
  const followUpRefreshes = useRef(new Map<string, Promise<void>>());
  const loaded = useRef(new Set<string>());
  const requested = useRef(new Set<string>());
  const active = useRef(true);
  const running = useRef(0);
  const waiting = useRef<Array<() => void>>([]);

  const startRequest = (directoryPath: string, refresh: boolean): Promise<void> => {
    loaded.current.add(directoryPath);
    requested.current.add(directoryPath);
    const atom = projectEnvironment.listEntries({ environmentId, input: { cwd, directoryPath } });
    const request = (async () => {
      if (running.current >= 4) await new Promise<void>((resolve) => waiting.current.push(resolve));
      else running.current++;
      const result = active.current
        ? await executeAtomQuery(appAtomRegistry, atom, {
            refresh: true,
            reportFailure: false,
            reportDefect: false,
          })
        : undefined;
      const next = waiting.current.shift();
      if (next) next();
      else running.current--;
      return result;
    })()
      .then((result) => {
        // A request is dropped from `requests` when its folder disappears, so its read is stale.
        if (!active.current || !result || requests.current.get(directoryPath) !== request) return;
        if (result._tag === "Success") {
          const next = new Map(listings.current).set(
            directoryPath,
            result.value.entries.filter(
              (entry) =>
                entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) === directoryPath,
            ),
          );
          const removed = [...requested.current].filter((path) => isDetached(next, path));
          for (const path of removed) {
            next.delete(path);
            loaded.current.delete(path);
            requested.current.delete(path);
            requests.current.delete(path);
          }
          listings.current = next;
          setDirectories(next);
          if (removed.length > 0)
            setLoadingDirectories((previous) => {
              const remaining = new Set(previous);
              for (const path of removed) remaining.delete(path);
              return remaining;
            });
          setErrors((previous) => {
            const remaining = new Map(previous);
            for (const path of [directoryPath, ...removed]) remaining.delete(path);
            return remaining;
          });
        } else {
          loaded.current.delete(directoryPath);
          const cause = Cause.squash(result.cause);
          setErrors((previous) =>
            new Map(previous).set(
              directoryPath,
              cause instanceof Error ? cause.message : "Unable to load folder.",
            ),
          );
        }
      })
      .finally(() => {
        const current = requests.current.get(directoryPath) === request;
        if (current) requests.current.delete(directoryPath);
        if (!active.current) return;
        setPending((count) => count - 1);
        if (!refresh && current)
          setLoadingDirectories((previous) => {
            const next = new Set(previous);
            next.delete(directoryPath);
            return next;
          });
      });
    requests.current.set(directoryPath, request);
    return request;
  };

  const load = function loadDirectory(directoryPath: string, refresh = false): Promise<void> {
    const existing = requests.current.get(directoryPath);
    if (existing) {
      if (!refresh) return existing;
      let followUp = followUpRefreshes.current.get(directoryPath);
      if (!followUp) {
        followUp = existing.then(() => {
          followUpRefreshes.current.delete(directoryPath);
          if (active.current && requested.current.has(directoryPath))
            return loadDirectory(directoryPath, true);
        });
        followUpRefreshes.current.set(directoryPath, followUp);
      }
      return followUp;
    }
    if (!refresh && loaded.current.has(directoryPath)) return Promise.resolve();
    setPending((count) => count + 1);
    if (!refresh) setLoadingDirectories((previous) => new Set(previous).add(directoryPath));
    return startRequest(directoryPath, refresh);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the root directory read on mount and marks the hook inactive so late reads are ignored
  useEffect(() => {
    active.current = true;
    if (!requests.current.has("") && !loaded.current.has("")) void startRequest("", false);
    return () => {
      active.current = false;
    };
  }, [startRequest]);

  // A folder read fails at once while its environment is unreachable; read it again once a new
  // session is up rather than leaving the error until someone retries by hand.
  const sessionGeneration = environmentCatalog.sessionGenerationAtom(environmentId);
  // A listener alone does not compute the atom, so nothing would follow the connection.
  useAtomMount(sessionGeneration);
  useAtomSubscribe(sessionGeneration, () => {
    for (const path of errors.keys()) void load(path);
  });

  const entries: ProjectEntry[] = [];
  const visit = (path: string) => {
    for (const entry of directories.get(path) ?? []) {
      entries.push(entry);
      if (entry.kind === "directory") visit(entry.path);
    }
  };
  visit("");

  const reachableDirectories = new Set([
    "",
    ...entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path),
  ]);

  const refresh = () => {
    const paths = [...requested.current].filter((path) => reachableDirectories.has(path));
    for (const path of paths) {
      if (!active.current) break;
      void load(path, true);
    }
  };

  return {
    entries,
    load,
    refresh,
    isPending: pending > 0,
    loadingDirectories,
    ready: directories.has(""),
    error: [...errors].find(([path]) => reachableDirectories.has(path))?.[1] ?? null,
  };
}
