import { RegistryContext } from "@effect/atom-react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import type { EnvironmentId } from "@t3tools/contracts";
import { useContext, useEffect, useState } from "react";

import { loadFilePatch } from "../state/changes";
import type { DiffSource } from "../state/filesView";
import type { ChangeFile } from "./changeSet";

/** How many files are read at once, so a large diff does not queue every file on the engine together. */
const CONCURRENCY = 4;

export interface FilePatches {
  /** The patches read so far, in the order of `files`. */
  readonly loaded: ReadonlyArray<FileDiffMetadata>;
  readonly failure: string | null;
}

/**
 * Reads the patch of each changed file, a few at a time, and hands them back as they arrive, so
 * the first file paints before the last has been read. `revision` starts the read over.
 */
export function useFilePatches(
  environmentId: EnvironmentId,
  cwd: string,
  diff: DiffSource,
  ignoreWhitespace: boolean,
  files: ReadonlyArray<ChangeFile> | null,
  revision: string,
): FilePatches {
  const registry = useContext(RegistryContext);
  const key = JSON.stringify([revision, environmentId, cwd, diff, ignoreWhitespace]);
  const [state, setState] = useState<{
    readonly key: string;
    readonly byPath: ReadonlyMap<string, ReadonlyArray<FileDiffMetadata>>;
    readonly failure: string | null;
  }>({ key, byPath: new Map(), failure: null });

  useEffect(() => {
    if (files === null) return;
    let stopped = false;
    const queue = [...files];
    const worker = async () => {
      for (;;) {
        const file = queue.shift();
        if (file === undefined || stopped) return;
        const path = file.path;
        try {
          const text = await loadFilePatch(
            registry,
            environmentId,
            cwd,
            diff,
            ignoreWhitespace,
            file,
          );
          if (stopped) return;
          const parsed =
            text.trim() === ""
              ? []
              : parsePatchFiles(text, { cacheKeyPrefix: `${revision}:${path}` }).flatMap(
                  (patch) => patch.files,
                );
          // A read for a newer diff starts the map over, so one for an older diff never lands in it.
          setState((before) => ({
            key,
            failure: null,
            byPath: new Map(before.key === key ? before.byPath : []).set(path, parsed),
          }));
        } catch (error) {
          if (!stopped) {
            setState((before) => ({
              key,
              byPath: before.key === key ? before.byPath : new Map(),
              failure: error instanceof Error ? error.message : String(error),
            }));
          }
        }
      }
    };
    for (let index = 0; index < CONCURRENCY; index++) void worker();
    return () => {
      stopped = true;
    };
  }, [registry, environmentId, cwd, diff, ignoreWhitespace, files, revision, key]);

  const current = state.key === key;
  return {
    loaded:
      current && files !== null ? files.flatMap((file) => state.byPath.get(file.path) ?? []) : [],
    failure: current ? state.failure : null,
  };
}
