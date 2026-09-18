import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

/** Loads only requested directories; collapsing a folder keeps its children cached. */
export function useDirectoryEntries(environmentId: EnvironmentId, cwd: string) {
  const [directories, setDirectories] = useState(new Map<string, readonly ProjectEntry[]>());
  const [errors, setErrors] = useState(new Map<string, string>());
  const [pending, setPending] = useState(0);
  const requests = useRef(new Map<string, Promise<void>>());
  const loaded = useRef(new Set<string>());
  const requested = useRef(new Set<string>());
  const active = useRef(true);
  const running = useRef(0);
  const waiting = useRef<Array<() => void>>([]);

  const load = useCallback(
    function loadDirectory(directoryPath: string, refresh = false): Promise<void> {
      const existing = requests.current.get(directoryPath);
      if (existing)
        return refresh ? existing.then(() => loadDirectory(directoryPath, true)) : existing;
      if (!refresh && loaded.current.has(directoryPath)) return Promise.resolve();
      loaded.current.add(directoryPath);
      requested.current.add(directoryPath);
      const atom = projectEnvironment.listEntries({ environmentId, input: { cwd, directoryPath } });
      setPending((count) => count + 1);
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
          if (active.current) setPending((count) => count - 1);
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
    // Refresh folders already visited, preserving the current expansion state.
    const paths = [...requested.current].filter((path) => reachableDirectories.has(path));
    let next = 0;
    const worker = async () => {
      while (next < paths.length && active.current) {
        const path = paths[next++];
        if (path !== undefined) await load(path, true);
      }
    };
    for (let index = 0; index < Math.min(4, paths.length); index++) void worker();
  }, [load, reachableDirectories]);

  return {
    entries,
    load,
    refresh,
    isPending: pending > 0,
    ready: directories.has(""),
    error: [...errors].find(([path]) => reachableDirectories.has(path))?.[1] ?? null,
  };
}
