import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { useCallback, useContext, useMemo, useRef, useState } from "react";

import { listFolder } from "../state/files";

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/**
 * The folders of one root, listed one level at a time as the tree opens them. Paths are relative
 * to `cwd`, because the engine lists only inside the `cwd` it is given.
 */
export function useDirectoryEntries(environmentId: EnvironmentId, cwd: string) {
  const registry = useContext(RegistryContext);
  const [directories, setDirectories] = useState<ReadonlyMap<string, ReadonlyArray<ProjectEntry>>>(
    new Map(),
  );
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const requested = useRef(new Set<string>());
  const inFlight = useRef(new Map<string, Promise<void>>());
  const active = useRef(true);

  const load = useCallback(
    (directoryPath: string, refresh = false): Promise<void> => {
      const pending = inFlight.current.get(directoryPath);
      if (pending !== undefined) return pending;
      if (!refresh && requested.current.has(directoryPath)) return Promise.resolve();
      requested.current.add(directoryPath);
      setLoading((previous) => new Set(previous).add(directoryPath));
      const request = (async () => {
        try {
          const entries = await listFolder(registry, environmentId, cwd, directoryPath);
          if (!active.current) return;
          const children = entries.filter((entry) => parentOf(entry.path) === directoryPath);
          const folders = new Set(
            children.filter((entry) => entry.kind === "directory").map((entry) => entry.path),
          );
          const prefix = directoryPath === "" ? "" : `${directoryPath}/`;
          // A folder the listing no longer has takes its own listing with it.
          const gone = [...requested.current].filter((path) => {
            if (path === directoryPath || !path.startsWith(prefix)) return false;
            const slash = path.indexOf("/", prefix.length);
            return !folders.has(slash === -1 ? path : path.slice(0, slash));
          });
          for (const path of gone) requested.current.delete(path);
          setDirectories((previous) => {
            const next = new Map(previous).set(directoryPath, children);
            for (const path of gone) next.delete(path);
            return next;
          });
          setErrors((previous) => {
            const next = new Map(previous);
            next.delete(directoryPath);
            return next;
          });
        } catch (error) {
          if (!active.current) return;
          requested.current.delete(directoryPath);
          const message = error instanceof Error ? error.message : String(error);
          setErrors((previous) => new Map(previous).set(directoryPath, message));
        } finally {
          inFlight.current.delete(directoryPath);
          if (active.current) {
            setLoading((previous) => {
              const next = new Set(previous);
              next.delete(directoryPath);
              return next;
            });
          }
        }
      })();
      inFlight.current.set(directoryPath, request);
      return request;
    },
    [registry, environmentId, cwd],
  );

  /** Starts the root listing and returns what stops the hook from using a late answer. Call it once the tree is on screen. */
  const attach = useCallback(() => {
    active.current = true;
    requested.current.clear();
    void load("");
    return () => {
      active.current = false;
    };
  }, [load]);

  // Every listed entry, a folder before what is inside it.
  const entries = useMemo(() => {
    const flat: ProjectEntry[] = [];
    const visit = (path: string) => {
      for (const entry of directories.get(path) ?? []) {
        flat.push(entry);
        if (entry.kind === "directory") visit(entry.path);
      }
    };
    visit("");
    return flat;
  }, [directories]);

  return {
    entries,
    attach,
    load,
    refresh: () => {
      for (const path of requested.current) void load(path, true);
    },
    ready: directories.has(""),
    loading,
    error: errors.values().next().value ?? null,
  };
}
