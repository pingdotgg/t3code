import type { CodeViewItemScrollTarget, CodeViewScrollTarget } from "@pierre/diffs";
import { useState } from "react";

interface FileRevealHandle {
  getInstance(): { getHeight(): number; getScrollHeight(): number } | undefined;
  getItem(id: string): object | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

/**
 * Scrolls a code view to a file. `attach` is the viewer's ref and `flush` its post-render
 * handler, so a reveal asked before the viewer mounts, or for a file it does not hold yet, is
 * positioned once it does. A reveal belongs to the diff it was asked of, so detaching the viewer,
 * such as remounting it for another diff scope, drops it.
 */
export function createCodeViewFileReveal(initialTarget?: CodeViewItemScrollTarget) {
  let restoring = initialTarget !== undefined;
  let viewer: FileRevealHandle | null = null;
  let pending: CodeViewItemScrollTarget | null = initialTarget ?? null;
  let applied: { viewer: FileRevealHandle; target: CodeViewItemScrollTarget } | null = null;
  const flush = () => {
    if (applied?.viewer === viewer) applied = null;
    if (pending === null || viewer === null) return;
    const instance = viewer.getInstance();
    if (
      !instance ||
      instance.getHeight() === 0 ||
      instance.getScrollHeight() === 0 ||
      viewer.getItem(pending.id) === undefined
    )
      return;
    const target = pending;
    pending = null;
    if (restoring) applied = { viewer, target };
    restoring = false;
    viewer.scrollTo(target);
  };
  return {
    attach(next: FileRevealHandle | null) {
      if (viewer !== null && next !== viewer) {
        if (applied?.viewer === viewer) {
          pending = applied.target;
          restoring = true;
          applied = null;
        } else if (!restoring) pending = null;
      }
      viewer = next;
      flush();
    },
    request(fileKey: string) {
      applied = null;
      restoring = false;
      pending = { type: "item", id: fileKey, align: "start" };
      flush();
    },
    flush,
  };
}

export function useCodeViewFileReveal(scopeKey?: string, initialTarget?: CodeViewItemScrollTarget) {
  const [state, setState] = useState(() => ({
    scopeKey,
    reveal: createCodeViewFileReveal(initialTarget),
  }));
  if (state.scopeKey !== scopeKey) {
    const next = { scopeKey, reveal: createCodeViewFileReveal(initialTarget) };
    setState(next);
    return next.reveal;
  }
  return state.reveal;
}
