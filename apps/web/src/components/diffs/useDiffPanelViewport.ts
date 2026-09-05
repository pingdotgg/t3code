import type { CodeViewScrollTarget } from "@pierre/diffs";
import { useCallback, useEffect, useRef } from "react";

import {
  type DiffPanelSelection,
  type DiffPanelViewport,
  useDiffPanelStore,
} from "../../diffPanelStore";

interface DiffViewportInstance {
  getRenderedItems(): ReadonlyArray<{ id: string }>;
  getTopForItem(id: string): number | undefined;
}

interface DiffViewportHandle {
  getInstance(): DiffViewportInstance | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

// Scroll frames only update this mounted view's capture. Store it when leaving the scope;
// Pierre resets its own position before the parent's unmount cleanup can read it.
export function useDiffPanelViewport(
  viewer: DiffViewportHandle | null,
  scopeKey: string | null,
  selection: DiffPanelSelection,
  selectedFileKey: string | null,
) {
  const captureRef = useRef<{
    scopeKey: string | null;
    scrollTop: number;
    fileAnchor: DiffPanelViewport["fileAnchor"];
    revealSelection: DiffPanelSelection | null;
    restoredInstance: object | undefined;
  } | null>(null);

  useEffect(() => {
    const store = useDiffPanelStore.getState();
    const saved = scopeKey ? store.viewportByScopeKey[scopeKey] : undefined;
    const capture = {
      scopeKey,
      scrollTop: saved?.scrollTop ?? 0,
      fileAnchor: saved?.fileAnchor,
      revealSelection: saved?.revealSelection ?? null,
      restoredInstance: undefined as object | undefined,
    };
    captureRef.current = capture;
    if (!scopeKey) return;
    const marker = saved ?? {
      scrollTop: capture.scrollTop,
      revealSelection: capture.revealSelection,
    };
    if (!saved) store.setViewport(scopeKey, marker);
    return () => {
      const current = useDiffPanelStore.getState();
      // Removing a thread or environment must not be undone by its panel's later cleanup.
      if (current.viewportByScopeKey[scopeKey] !== marker) return;
      current.setViewport(scopeKey, {
        scrollTop: capture.scrollTop,
        ...(capture.fileAnchor ? { fileAnchor: capture.fileAnchor } : {}),
        revealSelection: capture.revealSelection,
      });
    };
  }, [scopeKey]);

  useEffect(() => {
    const instance = viewer?.getInstance();
    const capture = captureRef.current;
    if (!instance || !viewer || !capture || capture.scopeKey !== scopeKey) return;
    // Selection identity distinguishes a new reveal even when its numeric request ID resets.
    if (selectedFileKey && capture.revealSelection !== selection) {
      capture.revealSelection = selection;
      capture.restoredInstance = instance;
      viewer.scrollTo({ type: "item", id: selectedFileKey, align: "start" });
    } else if (capture.restoredInstance !== instance) {
      let anchor = capture.fileAnchor;
      // Position targets subtract Pierre's sticky header, so restore relative to a file instead.
      if (!anchor || instance.getTopForItem(anchor.fileKey) === undefined) {
        anchor = undefined;
        for (const item of instance.getRenderedItems()) {
          const top = instance.getTopForItem(item.id);
          if (top === undefined) continue;
          anchor = { fileKey: item.id, offset: top - capture.scrollTop };
          break;
        }
      }
      if (!anchor) return;
      capture.restoredInstance = instance;
      viewer.scrollTo({
        type: "item",
        id: anchor.fileKey,
        offset: anchor.offset,
        align: "start",
        behavior: "instant",
      });
    }
  }, [scopeKey, selectedFileKey, selection, viewer]);

  return useCallback(
    (scrollTop: number, instance: DiffViewportInstance) => {
      const capture = captureRef.current;
      if (capture?.scopeKey !== scopeKey) return;
      capture.scrollTop = scrollTop;
      capture.fileAnchor = undefined;
      for (const item of instance.getRenderedItems()) {
        const top = instance.getTopForItem(item.id);
        if (top === undefined) continue;
        if (top > scrollTop && capture.fileAnchor) break;
        capture.fileAnchor = { fileKey: item.id, offset: top - scrollTop };
        if (top > scrollTop) break;
      }
    },
    [scopeKey],
  );
}
