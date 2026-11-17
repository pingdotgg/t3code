import type { CodeViewScrollTarget, SelectionSide } from "@pierre/diffs";
import { useEffect, useState } from "react";

interface Viewer {
  getHeight(): number;
  getRenderedItems(): readonly {
    id: string;
    instance: {
      getNumericScrollAnchor(
        localViewportTop: number,
      ): { lineNumber: number; top: number; side?: SelectionSide } | undefined;
    };
  }[];
  getTopForItem(id: string): number | undefined;
}

interface ScrollRestoreHandle {
  getInstance(): Viewer | undefined;
  getItem(id: string): { collapsed?: boolean } | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

// A remounted viewer estimates the height of files it has not measured, so a pixel offset lands
// in other content; the anchor is a file and line plus where it sat in the viewport.
interface ScrollAnchor {
  id: string;
  offset: number;
  line?: { lineNumber: number; side?: SelectionSide; offset: number };
}

// The panel's sticky file header, which Pierre keeps a line target below.
const STICKY_HEADER_HEIGHT = 32;

// Session-only, like the panel's folds.
const anchorByScopeKey = new Map<string, ScrollAnchor>();

function anchorAt(viewer: Viewer, scrollTop: number): ScrollAnchor | null {
  if (scrollTop <= 0) return null;
  const items = viewer.getRenderedItems().flatMap((item) => {
    const top = viewer.getTopForItem(item.id);
    return top === undefined ? [] : [{ item, top }];
  });
  const anchor = items.findLast(({ top }) => top <= scrollTop) ?? items[0];
  if (anchor === undefined) return null;
  const { item, top } = anchor;
  const line = item.instance.getNumericScrollAnchor(scrollTop + STICKY_HEADER_HEIGHT - top);
  return {
    id: item.id,
    offset: top - scrollTop,
    ...(line
      ? {
          line: {
            lineNumber: line.lineNumber,
            ...(line.side ? { side: line.side } : {}),
            offset: top + line.top - STICKY_HEADER_HEIGHT - scrollTop,
          },
        }
      : {}),
  };
}

/**
 * Puts a remounted code view back on the file and line its scope was last scrolled to. `attach`
 * is the viewer's ref and `flush` its post-render handler; the anchor waits until its file is
 * loaded, loading more files while any remain, and falls back to the file once none are left.
 */
export function createCodeViewScrollRestore() {
  let scopeKey: string | null = null;
  let settled = true;
  let loadMore: (() => void) | null = null;
  let viewer: Viewer | undefined;
  let handle: ScrollRestoreHandle | null = null;
  let pending: ScrollAnchor | null = null;
  const flush = () => {
    if (pending === null || !viewer || !handle || viewer.getHeight() === 0) return;
    const item = handle.getItem(pending.id);
    const loaded = item !== undefined && (pending.line === undefined || item.collapsed !== true);
    if (!loaded && !settled) {
      loadMore?.();
      return;
    }
    const { id, offset, line } = pending;
    pending = null;
    if (item === undefined) return;
    handle.scrollTo(
      line && loaded
        ? { type: "line", id, align: "start", ...line }
        : { type: "item", id, align: "start", offset },
    );
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
        pending = scopeKey === null ? null : (anchorByScopeKey.get(scopeKey) ?? null);
      }
      flush();
    },
    onScroll(scrollTop: number, source: object) {
      if (!viewer || source !== viewer || pending !== null || scopeKey === null) return;
      const anchor = anchorAt(viewer, scrollTop);
      if (anchor) anchorByScopeKey.set(scopeKey, anchor);
      else anchorByScopeKey.delete(scopeKey);
    },
    /** Something else positions the viewer, such as a file reveal or collapsing every file. */
    discard() {
      pending = null;
      if (scopeKey !== null) anchorByScopeKey.delete(scopeKey);
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a loaded batch can leave the viewer's rendered items alone, so no ref or post-render call re-checks the pending anchor
  useEffect(() => restore.flush());
  return restore;
}
