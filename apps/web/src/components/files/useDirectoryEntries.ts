import { RegistryContext } from "@effect/atom-react";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectEntry, ProjectListEntriesResult } from "@t3tools/contracts";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { getProjectEntriesQueryAtom } from "./projectFilesQueryState";

const MAX_CONCURRENT_DIRECTORY_LOADS = 4;

export function useDirectoryEntries(environmentId: EnvironmentId, cwd: string) {
  const registry = useContext(RegistryContext);
  const [directories, setDirectories] = useState<Record<string, ProjectListEntriesResult>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(0);
  const loader = useRef<{
    request: (directory: string, refresh?: boolean) => Promise<void>;
    refresh: () => void;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const cache = new Map<string, ProjectListEntriesResult>();
    const requests = new Map<string, Promise<void>>();
    const visited = new Set<string>();
    const queue: { run: () => Promise<void>; cancel: () => void }[] = [];
    let running = 0;
    setDirectories({});
    setErrors({});
    setPending(0);

    const pump = () => {
      while (
        !controller.signal.aborted &&
        running < MAX_CONCURRENT_DIRECTORY_LOADS &&
        queue.length
      ) {
        const task = queue.shift();
        if (!task) break;
        running++;
        void task.run().finally(() => {
          running--;
          pump();
        });
      }
    };
    const request = (directory: string, refresh = false): Promise<void> => {
      const existing = requests.get(directory);
      if (existing) return existing;
      if (!refresh && cache.has(directory)) return Promise.resolve();
      if (controller.signal.aborted) return Promise.resolve();
      let resolve: (() => void) | undefined;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      requests.set(directory, promise);
      visited.add(directory);
      setPending(requests.size);
      queue.push({
        cancel: () => resolve?.(),
        run: async () => {
          try {
            const result = await executeAtomQuery(
              registry,
              getProjectEntriesQueryAtom(environmentId, cwd, directory),
              {
                refresh,
                signal: controller.signal,
                label: "Load workspace directory",
                reportFailure: false,
              },
            );
            if (controller.signal.aborted) return;
            if (result._tag === "Success") {
              cache.set(directory, result.value);
              setDirectories((previous) => ({ ...previous, [directory]: result.value }));
              setErrors((previous) => {
                const next = { ...previous };
                delete next[directory];
                return next;
              });
            } else {
              const cause = squashAtomCommandFailure(result);
              setErrors((previous) => ({
                ...previous,
                [directory]: cause instanceof Error ? cause.message : "Could not load directory.",
              }));
            }
          } finally {
            requests.delete(directory);
            if (!controller.signal.aborted) setPending(requests.size);
            resolve?.();
          }
        },
      });
      pump();
      return promise;
    };
    loader.current = {
      request,
      refresh: () => {
        const previouslyVisited = new Set(visited);
        const visit = async (directory: string): Promise<void> => {
          await request(directory, true);
          if (controller.signal.aborted) return;
          await Promise.all(
            (cache.get(directory)?.entries ?? []).map((entry) => {
              if (entry.kind === "directory" && previouslyVisited.has(entry.path)) {
                return visit(entry.path);
              }
              return undefined;
            }),
          );
        };
        void visit("");
      },
    };
    void request("", true);
    return () => {
      controller.abort();
      for (const task of queue.splice(0)) task.cancel();
      loader.current = null;
    };
  }, [cwd, environmentId, registry]);

  const loadDirectory = useCallback(
    (directory: string, refresh = false) =>
      loader.current?.request(directory, refresh) ?? Promise.resolve(),
    [],
  );
  const refresh = useCallback(() => loader.current?.refresh(), []);
  const reachable = useMemo(() => {
    const result: ProjectEntry[] = [];
    const paths = new Set([""]);
    let truncated = false;
    const visit = (directory: string) => {
      paths.add(directory);
      truncated ||= directories[directory]?.truncated ?? false;
      for (const entry of directories[directory]?.entries ?? []) {
        result.push(entry);
        if (entry.kind === "directory") visit(entry.path);
      }
    };
    visit("");
    return { entries: result, paths, truncated };
  }, [directories]);
  return {
    entries: reachable.entries,
    error: Object.entries(errors)
      .filter(([directory]) => reachable.paths.has(directory))
      .map(([directory, message]) => `${directory || "Workspace"}: ${message}`)
      .join("\n"),
    pending,
    rootLoaded: directories[""] !== undefined,
    truncated: reachable.truncated,
    loadDirectory,
    refresh,
  };
}
