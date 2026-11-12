import type { CodeViewScrollTarget } from "@pierre/diffs";
import { useState } from "react";

interface Viewer {
  getHeight(): number;
  getScrollHeight(): number;
}

interface ScrollRestoreHandle {
  getInstance(): Viewer | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

// Session-only, like the panel's folds.
const scrollTopByScopeKey = new Map<string, number>();

/**
 * Puts a remounted code view back where its scope was last scrolled. `attach` is the viewer's
 * ref and `flush` its post-render handler; the position waits until the content can reach it or
 * nothing is loading any more.
 */
export function createCodeViewScrollRestore() {
  let scopeKey: string | null = null;
  let settled = true;
  let viewer: Viewer | undefined;
  let handle: ScrollRestoreHandle | null = null;
  let pending: number | null = null;
  const flush = () => {
    if (pending === null || !viewer || !handle || viewer.getHeight() === 0) return;
    const maxScrollTop = viewer.getScrollHeight() - viewer.getHeight();
    if (maxScrollTop < pending && !settled) return;
    // Pierre lands an unclamped position target one sticky header (32px) above it.
    const position = pending + 32 <= maxScrollTop ? pending + 32 : maxScrollTop;
    pending = null;
    if (position > 0) handle.scrollTo({ type: "position", position });
  };
  return {
    update(nextScopeKey: string | null, nextSettled: boolean) {
      scopeKey = nextScopeKey;
      settled = nextSettled;
    },
    attach(next: ScrollRestoreHandle | null) {
      handle = next;
      const instance = next?.getInstance();
      if (instance && instance !== viewer) {
        viewer = instance;
        pending = scopeKey === null ? null : (scrollTopByScopeKey.get(scopeKey) ?? null);
      }
      flush();
    },
    onScroll(scrollTop: number, source: object) {
      if (source !== viewer || pending !== null || scopeKey === null) return;
      scrollTopByScopeKey.set(scopeKey, scrollTop);
    },
    /** Something else positions the viewer, such as a file reveal or collapsing every file. */
    discard() {
      pending = null;
      if (scopeKey !== null) scrollTopByScopeKey.delete(scopeKey);
    },
    flush,
  };
}

export function useCodeViewScrollRestore(scopeKey: string | null, settled: boolean) {
  const [restore] = useState(createCodeViewScrollRestore);
  restore.update(scopeKey, settled);
  return restore;
}
