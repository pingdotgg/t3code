import type { FileDiffMetadata } from "@pierre/diffs";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { buildFileDiffContentVersion } from "./lib/diffRendering";
import { resolveStorage } from "./lib/storage";

// Nothing removes a thread's entries when it goes away, so both levels drop their oldest.
const MAX_VIEWED_FILES_PER_THREAD = 2000;
const MAX_VIEWED_THREADS = 100;

/**
 * Identifies the reviewed contents of a file. Blob ids survive the whitespace toggle, which
 * changes the hunks but not the files; diffs without them fall back to the rendered content.
 */
export function diffViewedFingerprint(fileDiff: FileDiffMetadata): string {
  return fileDiff.prevObjectId && fileDiff.newObjectId
    ? `${fileDiff.prevObjectId}..${fileDiff.newObjectId}`
    : `v${buildFileDiffContentVersion(fileDiff)}`;
}

export function diffViewedEntry(filePath: string, fingerprint: string): string {
  return `${filePath}\u0000${fingerprint}`;
}

interface DiffViewedStoreState {
  /** Per thread, viewed `path\0fingerprint` entries, newest last. Threads are oldest first. */
  viewedByThreadKey: Record<string, ReadonlyArray<string>>;
  setFileViewed: (
    threadKey: string,
    filePath: string,
    fingerprint: string,
    viewed: boolean,
  ) => void;
}

export const useDiffViewedStore = create<DiffViewedStoreState>()(
  persist(
    (set) => ({
      viewedByThreadKey: {},
      setFileViewed: (threadKey, filePath, fingerprint, viewed) =>
        set((state) => {
          const pathPrefix = diffViewedEntry(filePath, "");
          const entries = (state.viewedByThreadKey[threadKey] ?? []).filter(
            (entry) => !entry.startsWith(pathPrefix),
          );
          if (viewed) entries.push(diffViewedEntry(filePath, fingerprint));
          const { [threadKey]: _previous, ...others } = state.viewedByThreadKey;
          const threads = Object.entries(others);
          if (entries.length > 0)
            threads.push([threadKey, entries.slice(-MAX_VIEWED_FILES_PER_THREAD)]);
          return { viewedByThreadKey: Object.fromEntries(threads.slice(-MAX_VIEWED_THREADS)) };
        }),
    }),
    {
      name: "t3code:diff-viewed-files:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ viewedByThreadKey: state.viewedByThreadKey }),
    },
  ),
);
