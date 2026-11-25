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
const savedByScopeKey = new Map<string, { readonly scrollTop: number; readonly loaded: number }>();

/**
 * Puts a remounted code view back where its scope was last scrolled. `attach` is the viewer's
 * ref and `flush` its post-render handler; the position waits until the content can reach it,
 * loading more files while any remain, and clamps once nothing is left to load. `loaded` counts
 * the batches shown, for a caller whose batches reorder as they arrive.
 */
export function createCodeViewScrollRestore() {
  let scopeKey: string | null = null;
  let settled = true;
  let loadMore: (() => void) | null = null;
  let loaded = 0;
  let viewer: Viewer | undefined;
  let handle: ScrollRestoreHandle | null = null;
  let pending: { readonly scrollTop: number; readonly loaded: number } | null = null;
  const flush = () => {
    if (pending === null || !viewer || !handle || viewer.getHeight() === 0) return;
    const maxScrollTop = viewer.getScrollHeight() - viewer.getHeight();
    // Until as many batches are back as when it was saved, the offset can name another file.
    if (!settled && (loaded < pending.loaded || maxScrollTop < pending.scrollTop)) {
      loadMore?.();
      return;
    }
    const scrollTop = Math.min(pending.scrollTop, maxScrollTop);
    pending = null;
    // Pierre lands a position target one sticky header (32px) above it, unless it clamps it.
    if (scrollTop > 0) handle.scrollTo({ type: "position", position: scrollTop + 32 });
  };
  return {
    update(
      nextScopeKey: string | null,
      nextSettled: boolean,
      nextLoadMore: (() => void) | null,
      nextLoaded = 0,
    ) {
      // A viewer kept across a scope change takes the new scope's position, never the old one's.
      if (viewer && nextScopeKey !== scopeKey) {
        pending = nextScopeKey === null ? null : (savedByScopeKey.get(nextScopeKey) ?? null);
      }
      scopeKey = nextScopeKey;
      settled = nextSettled;
      loadMore = nextLoadMore;
      loaded = nextLoaded;
    },
    attach(next: ScrollRestoreHandle | null) {
      handle = next;
      const instance = next?.getInstance();
      if (instance && instance !== viewer) {
        viewer = instance;
        pending = scopeKey === null ? null : (savedByScopeKey.get(scopeKey) ?? null);
      }
      flush();
    },
    onScroll(scrollTop: number, source: object) {
      if (source !== viewer || pending !== null || scopeKey === null) return;
      savedByScopeKey.set(scopeKey, { scrollTop, loaded });
    },
    /** The reader scrolled before the saved position was reached; their scroll wins. */
    cancel() {
      pending = null;
    },
    /** Something else positions the viewer, such as a file reveal or collapsing every file. */
    discard() {
      pending = null;
      if (scopeKey !== null) savedByScopeKey.delete(scopeKey);
    },
    flush,
  };
}

export function useCodeViewScrollRestore(
  scopeKey: string | null,
  settled: boolean,
  loadMore: (() => void) | null,
  loaded = 0,
) {
  const [restore] = useState(createCodeViewScrollRestore);
  restore.update(scopeKey, settled, loadMore, loaded);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a loaded batch can leave the viewer's rendered items alone, so no ref or post-render call re-checks the pending position
  useEffect(() => restore.flush());
  return restore;
}
