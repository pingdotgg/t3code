import {
  DEFAULT_TOKENIZE_MAX_LENGTH,
  getFiletypeFromFileName,
  type FileContents,
  type PostRenderPhase,
} from "@pierre/diffs";
import { useWorkerPool } from "@pierre/diffs/react";
import type { WorkerPoolManager } from "@pierre/diffs/worker";
import { useEffect, useState } from "react";

function needsWorkerHighlight(workerPool: WorkerPoolManager | undefined, file: FileContents) {
  if (workerPool?.isWorkingPool() !== true) return false;
  if ((file.lang ?? getFiletypeFromFileName(file.name)) === "text") return false;
  let lines = 1;
  for (
    let index = file.contents.indexOf("\n");
    index !== -1;
    index = file.contents.indexOf("\n", index + 1)
  ) {
    lines += 1;
  }
  return lines <= DEFAULT_TOKENIZE_MAX_LENGTH;
}

/** Enable editing only after worker highlighting renders; active edit sessions highlight on the main
 * thread. */
export function useEditableAfterHighlight(file: FileContents) {
  const workerPool = useWorkerPool();
  const [highlightedFile, setHighlightedFile] = useState<FileContents | null>(null);
  const needsHighlight = needsWorkerHighlight(workerPool, file);
  const ready = !needsHighlight || highlightedFile === file;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- primes the worker pool's highlight cache for this file and falls back to plain text if it fails
  useEffect(() => {
    if (ready || workerPool === undefined) return;
    workerPool.primeFileHighlightCache(file).catch(() => setHighlightedFile(file));
  }, [file, ready, workerPool]);

  const onPostRender = (renderedFile: FileContents | undefined, phase: PostRenderPhase) => {
    if (ready || phase === "unmount" || renderedFile?.cacheKey !== file.cacheKey) return;
    // Cache results arrive just before instance rendering; seeing the cache during render means rows are
    // highlighted.
    if (workerPool?.getFileResultCache(file) !== undefined) setHighlightedFile(file);
  };
  return { ready, onPostRender };
}
