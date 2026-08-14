import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useThreadCheckpoints } from "../state/entities";

/**
 * Keeps an open file preview in sync with on-disk changes.
 *
 * The `readFile` query backing the preview is cached (see `staleTimeMs` in
 * client-runtime's projectCommands), so once a file is shown the preview will
 * not reflect later edits on its own. A real editor like VSCode refreshes via a
 * filesystem watcher; we don't have one, so we refetch on the two signals we can
 * observe from the renderer:
 *
 *   1. An agent turn finishes — a new checkpoint lands, or a revert rewrites the
 *      checkpoint list. This covers in-app edits (the common case: you ask the
 *      agent to change a file and expect the open preview to update).
 *   2. The window regains focus — covers edits made outside the app (e.g. in a
 *      terminal), the way an editor refreshes when you tab back to it.
 *
 * We deliberately refetch on *any* checkpoint change rather than matching the
 * open file against each checkpoint's `files`: checkpoint paths and the
 * preview's repo-relative path can be rooted differently, and a single extra
 * file read is far cheaper than silently leaving the preview stale.
 */
export function usePreviewFileFreshness(
  threadRef: ScopedThreadRef | null,
  relativePath: string | null,
  refresh: () => void,
): void {
  const checkpoints = useThreadCheckpoints(threadRef);

  // A signature that changes when a turn completes or a revert trims the list.
  const latest = checkpoints.at(-1);
  const checkpointSignature = `${checkpoints.length}:${latest?.checkpointTurnCount ?? ""}:${latest?.completedAt ?? ""}`;

  const previousSignature = useRef<string | null>(null);
  useEffect(() => {
    if (relativePath === null) {
      previousSignature.current = null;
      return;
    }
    // Skip the first observation for a file — its initial query is already
    // fresh. Only react to checkpoint activity that happens while it is open.
    if (previousSignature.current !== null && previousSignature.current !== checkpointSignature) {
      refresh();
    }
    previousSignature.current = checkpointSignature;
  }, [checkpointSignature, relativePath, refresh]);

  useEffect(() => {
    if (relativePath === null) return;
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [relativePath, refresh]);
}
