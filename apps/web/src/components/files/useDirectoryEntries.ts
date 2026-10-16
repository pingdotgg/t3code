import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

export function useDirectoryEntries(environmentId: EnvironmentId, cwd: string) {
  const [directories, setDirectories] = useState(new Map<string, readonly ProjectEntry[]>());
  const [errors, setErrors] = useState(new Map<string, string>());
  const [pending, setPending] = useState(0);
  const [loadingDirectories, setLoadingDirectories] = useState<ReadonlySet<string>>(new Set());
  const requests = useRef(new Map<string, Promise<void>>());
  const followUpRefreshes = useRef(new Map<string, Promise<void>>());
  const loaded = useRef(new Set<string>());
  const requested = useRef(new Set<string>());
  const active = useRef(true);
  const running = useRef(0);
  const waiting = useRef<Array<() => void>>([]);

  const load = useCallback(
    function loadDirectory(directoryPath: string, refresh = false): Promise<void> {
      const existing = requests.current.get(directoryPath);
      if (existing) {
        if (!refresh) return existing;
        // Share one rescan after this listing; mutations during that rescan can queue another.
        let followUp = followUpRefreshes.current.get(directoryPath);
        if (!followUp) {
          followUp = existing.then(() => {
            followUpRefreshes.current.delete(directoryPath);
            if (active.current) return loadDirectory(directoryPath, true);
          });
          followUpRefreshes.current.set(directoryPath, followUp);
        }
        return followUp;
      }
      if (!refresh && loaded.current.has(directoryPath)) return Promise.resolve();
      loaded.current.add(directoryPath);
      requested.current.add(directoryPath);
      const atom = projectEnvironment.listEntries({ environmentId, input: { cwd, directoryPath } });
      setPending((count) => count + 1);
      if (!refresh) setLoadingDirectories((previous) => new Set(previous).add(directoryPath));
      const request = (async () => {
        if (running.current >= 4)
          await new Promise<void>((resolve) => waiting.current.push(resolve));
        else running.current++;
        try {
          if (!active.current) return undefined;
          return await executeAtomQuery(appAtomRegistry, atom, {
            refresh: true,
            reportFailure: false,
            reportDefect: false,
          });
        } finally {
          const next = waiting.current.shift();
          if (next) next();
          else running.current--;
        }
      })()
        .then((result) => {
          if (!active.current || !result) return;
          if (result._tag === "Success") {
            setDirectories((previous) =>
              new Map(previous).set(
                directoryPath,
                result.value.entries.filter(
                  (entry) =>
                    entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) === directoryPath,
                ),
              ),
            );
            setErrors((previous) => {
              const next = new Map(previous);
              next.delete(directoryPath);
              return next;
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
          requests.current.delete(directoryPath);
          if (!active.current) return;
          setPending((count) => count - 1);
          if (!refresh)
            setLoadingDirectories((previous) => {
              const next = new Set(previous);
              next.delete(directoryPath);
              return next;
            });
        });
      requests.current.set(directoryPath, request);
      return request;
    },
    [cwd, environmentId],
  );

  useEffect(() => {
    active.current = true;
    void load("");
    return () => {
      active.current = false;
    };
  }, [load]);

  const entries = useMemo(() => {
    const result: ProjectEntry[] = [];
    const visit = (path: string) => {
      for (const entry of directories.get(path) ?? []) {
        result.push(entry);
        if (entry.kind === "directory") visit(entry.path);
      }
    };
    visit("");
    return result;
  }, [directories]);

  const reachableDirectories = useMemo(
    () =>
      new Set([
        "",
        ...entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path),
      ]),
    [entries],
  );

  const refresh = useCallback(() => {
    const paths = [...requested.current].filter((path) => reachableDirectories.has(path));
    // load owns the concurrency limit and coalesces each directory's queued refresh.
    for (const path of paths) {
      if (!active.current) break;
      void load(path, true);
    }
  }, [load, reachableDirectories]);

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
