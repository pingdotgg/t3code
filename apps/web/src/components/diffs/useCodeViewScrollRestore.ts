import type { CodeViewScrollTarget } from "@pierre/diffs";
import { useEffect, useState } from "react";

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
 * ref and `flush` its post-render handler; the position waits until the content can reach it,
 * loading more files while any remain, and clamps once nothing is left to load.
 */
export function createCodeViewScrollRestore() {
  let scopeKey: string | null = null;
  let settled = true;
  let loadMore: (() => void) | null = null;
  let viewer: Viewer | undefined;
  let handle: ScrollRestoreHandle | null = null;
  let pending: number | null = null;
  const flush = () => {
    if (pending === null || !viewer || !handle || viewer.getHeight() === 0) return;
    const maxScrollTop = viewer.getScrollHeight() - viewer.getHeight();
    if (maxScrollTop < pending && !settled) {
      loadMore?.();
      return;
    }
    // Pierre lands an unclamped position target one sticky header (32px) above it.
    const position = pending + 32 <= maxScrollTop ? pending + 32 : maxScrollTop;
    pending = null;
    if (position > 0) handle.scrollTo({ type: "position", position });
  };
  return {
    update(nextScopeKey: string | null, nextSettled: boolean, nextLoadMore: (() => void) | null) {
      scopeKey = nextScopeKey;
      settled = nextSettled;
      loadMore = nextLoadMore;
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

export function useCodeViewScrollRestore(
  scopeKey: string | null,
  settled: boolean,
  loadMore: (() => void) | null,
) {
  const [restore] = useState(createCodeViewScrollRestore);
  restore.update(scopeKey, settled, loadMore);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a loaded batch can leave the viewer's rendered items alone, so no ref or post-render call re-checks the pending position
  useEffect(() => restore.flush());
  return restore;
}
