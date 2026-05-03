import type { EnvironmentId, ProjectEntry } from "@forma/contracts";

import { loadProjectFileForEditor } from "./projectFileReadCache";

export const SMALL_DIRECTORY_PREFETCH_FILE_CAP = 12;
export const VISIBLE_SLICE_PREFETCH_FILE_CAP = 8;
export const PREFETCH_CONCURRENCY = 3;

type IdleCallbackHandle = number;
type IdleDeadlineLike = {
  didTimeout: boolean;
  timeRemaining(): number;
};
type IdleCallback = (deadline: IdleDeadlineLike) => void;
type RequestIdleCallbackFn = (callback: IdleCallback) => IdleCallbackHandle;
type CancelIdleCallbackFn = (handle: IdleCallbackHandle) => void;

function isFileEntry(entry: ProjectEntry): boolean {
  return entry.kind === "file";
}

export function selectWorkspaceDirectoryPrefetchPaths(
  entries: readonly ProjectEntry[],
  options?: {
    smallDirectoryFileCap?: number;
    visibleSliceFileCap?: number;
  },
): readonly string[] {
  const filePaths = entries.filter(isFileEntry).map((entry) => entry.path);
  if (filePaths.length === 0) {
    return [];
  }

  const smallDirectoryFileCap = options?.smallDirectoryFileCap ?? SMALL_DIRECTORY_PREFETCH_FILE_CAP;
  const visibleSliceFileCap = options?.visibleSliceFileCap ?? VISIBLE_SLICE_PREFETCH_FILE_CAP;

  if (filePaths.length <= smallDirectoryFileCap) {
    return filePaths;
  }

  return filePaths.slice(0, visibleSliceFileCap);
}

export async function prefetchWorkspaceDirectoryEntries(input: {
  environmentId: EnvironmentId;
  cwd: string;
  entries: readonly ProjectEntry[];
  concurrency?: number;
  prefetchFile?: ((relativePath: string) => Promise<void>) | undefined;
  smallDirectoryFileCap?: number;
  visibleSliceFileCap?: number;
}): Promise<void> {
  const filePaths = selectWorkspaceDirectoryPrefetchPaths(
    input.entries,
    input.smallDirectoryFileCap === undefined && input.visibleSliceFileCap === undefined
      ? undefined
      : {
          ...(input.smallDirectoryFileCap !== undefined
            ? { smallDirectoryFileCap: input.smallDirectoryFileCap }
            : {}),
          ...(input.visibleSliceFileCap !== undefined
            ? { visibleSliceFileCap: input.visibleSliceFileCap }
            : {}),
        },
  );
  if (filePaths.length === 0) {
    return;
  }

  const concurrency = Math.max(1, input.concurrency ?? PREFETCH_CONCURRENCY);
  const prefetchFile =
    input.prefetchFile ??
    (async (relativePath: string) => {
      await loadProjectFileForEditor({
        environmentId: input.environmentId,
        cwd: input.cwd,
        relativePath,
      });
    });

  let cursor = 0;
  const workerCount = Math.min(concurrency, filePaths.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const filePath = filePaths[cursor];
        cursor += 1;
        if (!filePath) {
          return;
        }

        try {
          await prefetchFile(filePath);
        } catch {
          // Best-effort warming only; file-specific failures should not surface in the tree.
        }
      }
    }),
  );
}

export function scheduleWorkspaceDirectoryPrefetch(input: {
  environmentId: EnvironmentId;
  cwd: string;
  entries: readonly ProjectEntry[];
  concurrency?: number;
  prefetchFile?: ((relativePath: string) => Promise<void>) | undefined;
  smallDirectoryFileCap?: number;
  visibleSliceFileCap?: number;
}): () => void {
  const targetWindow = typeof window === "undefined" ? undefined : window;
  let cancelled = false;

  const run = () => {
    if (cancelled) {
      return;
    }
    void prefetchWorkspaceDirectoryEntries(input);
  };

  if (targetWindow) {
    const requestIdleCallback = targetWindow.requestIdleCallback as
      | RequestIdleCallbackFn
      | undefined;
    const cancelIdleCallback = targetWindow.cancelIdleCallback as CancelIdleCallbackFn | undefined;
    if (requestIdleCallback) {
      const handle = requestIdleCallback(() => {
        run();
      });
      return () => {
        cancelled = true;
        cancelIdleCallback?.(handle);
      };
    }

    const timeoutHandle = targetWindow.setTimeout(run, 0);
    return () => {
      cancelled = true;
      targetWindow.clearTimeout(timeoutHandle);
    };
  }

  run();
  return () => {
    cancelled = true;
  };
}
