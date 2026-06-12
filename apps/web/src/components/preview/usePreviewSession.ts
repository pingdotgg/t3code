"use client";

import { scopedThreadKey } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { ensureEnvironmentApi } from "~/environmentApi";
import { usePreviewStateStore } from "~/previewStateStore";

/**
 * Subscribes to the server's per-thread preview events and replays the
 * latest snapshot on mount.
 *
 * Reconnect-recovery: when the local renderer remembers a snapshot but the
 * server has none (server restarted while we were alive), re-issue
 * `preview.open` so subsequent events land on a real session.
 */
export function usePreviewSession(threadRef: ScopedThreadRef): void {
  const applyServerSnapshot = usePreviewStateStore((state) => state.applyServerSnapshot);
  const applyServerEvent = usePreviewStateStore((state) => state.applyServerEvent);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const api = ensureEnvironmentApi(threadRef.environmentId);
    const threadIdValue = threadRef.threadId;
    let cancelled = false;

    void api.preview
      .list({ threadId: threadIdValue })
      .then((result) => {
        if (cancelled) return;
        // Pick the most recent session. Server returns sessions sorted by
        // `updatedAt` ascending, so the last one is freshest.
        const serverSnapshot = result.sessions.at(-1) ?? null;
        if (serverSnapshot) {
          for (const snapshot of result.sessions) applyServerSnapshot(threadRef, snapshot);
          return;
        }
        // Server has no sessions — try to recover what the renderer
        // remembers from before the disconnect.
        const localSnapshot =
          usePreviewStateStore.getState().byThreadKey[scopedThreadKey(threadRef)]?.snapshot;
        const recoverableUrl =
          localSnapshot && localSnapshot.navStatus._tag !== "Idle"
            ? localSnapshot.navStatus.url
            : null;
        if (recoverableUrl) {
          void api.preview
            .open({ threadId: threadIdValue, url: recoverableUrl })
            .catch(() => undefined);
        } else {
          applyServerSnapshot(threadRef, null);
        }
      })
      .catch(() => undefined);

    const unsubscribe = api.preview.onEvent((event) => {
      if (event.threadId !== threadIdValue) return;
      applyServerEvent(threadRef, event);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyServerEvent, applyServerSnapshot, threadRef]);
}
