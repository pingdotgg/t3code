import type { CodeViewScrollTarget } from "@pierre/diffs";
import { useCallback, useEffect, useRef } from "react";

import { type DiffPanelSelection, useDiffPanelStore } from "../../diffPanelStore";

interface DiffViewportHandle {
  getInstance(): object | undefined;
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
    revealSelection: DiffPanelSelection | null;
    restoredInstance: object | undefined;
  } | null>(null);

  useEffect(() => {
    const store = useDiffPanelStore.getState();
    const saved = scopeKey ? store.viewportByScopeKey[scopeKey] : undefined;
    const capture = {
      scopeKey,
      scrollTop: saved?.scrollTop ?? 0,
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
      capture.restoredInstance = instance;
      viewer.scrollTo({ type: "position", position: capture.scrollTop, behavior: "instant" });
    }
  }, [scopeKey, selectedFileKey, selection, viewer]);

  return useCallback(
    (scrollTop: number) => {
      const capture = captureRef.current;
      if (capture?.scopeKey === scopeKey) capture.scrollTop = scrollTop;
    },
    [scopeKey],
  );
}
