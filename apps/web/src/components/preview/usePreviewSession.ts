"use client";

import { scopedThreadKey } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { ensureEnvironmentApi, readEnvironmentApi } from "~/environmentApi";
import { readEnvironmentConnection, subscribeEnvironmentConnections } from "~/environments/runtime";
import { readPreviewStateRevision, usePreviewStateStore } from "~/previewStateStore";

import { refreshPreviewSessionState, usePreviewSessionState } from "./previewSessionState";

/**
 * Subscribes to the server's per-thread preview events and replays the
 * latest snapshot on mount.
 *
 * Reconnect-recovery: when the local renderer remembers a snapshot but the
 * server has none (server restarted while we were alive), re-issue
 * `preview.open` so subsequent events land on a real session.
 */
export function usePreviewSession(threadRef: ScopedThreadRef): void {
  const query = usePreviewSessionState(threadRef);
  const applyServerSnapshot = usePreviewStateStore((state) => state.applyServerSnapshot);
  const applyServerEvent = usePreviewStateStore((state) => state.applyServerEvent);

  useEffect(() => {
    // SWR retains stale data while revalidating. Do not project that stale
    // snapshot back into the live store because it can resurrect a session
    // that was just closed.
    if (
      query.isPending ||
      !query.data ||
      query.data.revision !== readPreviewStateRevision(threadRef)
    ) {
      return;
    }
    const threadIdValue = threadRef.threadId;
    let cancelled = false;
    if (query.data.result.sessions.length > 0) {
      for (const snapshot of query.data.result.sessions) {
        applyServerSnapshot(threadRef, snapshot);
      }
      return;
    }

    // Server has no sessions — try to recover what the renderer remembers
    // from before the disconnect.
    const localSnapshot =
      usePreviewStateStore.getState().byThreadKey[scopedThreadKey(threadRef)]?.snapshot;
    const recoverableUrl =
      localSnapshot && localSnapshot.navStatus._tag !== "Idle" ? localSnapshot.navStatus.url : null;
    if (!recoverableUrl) {
      applyServerSnapshot(threadRef, null);
      return;
    }

    const api = ensureEnvironmentApi(threadRef.environmentId);
    void api.preview
      .open({ threadId: threadIdValue, url: recoverableUrl })
      .then((snapshot) => {
        if (cancelled) return;
        applyServerSnapshot(threadRef, snapshot);
        refreshPreviewSessionState(threadRef);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [applyServerSnapshot, query.data, query.isPending, threadRef]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let clientIdentity: object | null = null;
    let unsubscribeEvents: () => void = () => undefined;

    const attach = () => {
      const connection = readEnvironmentConnection(threadRef.environmentId);
      const api = readEnvironmentApi(threadRef.environmentId);
      const nextIdentity = connection?.client ?? api ?? null;
      if (nextIdentity === clientIdentity) return;

      unsubscribeEvents();
      unsubscribeEvents = () => undefined;
      clientIdentity = nextIdentity;
      if (!api) return;

      refreshPreviewSessionState(threadRef);
      unsubscribeEvents = api.preview.onEvent(
        (event) => {
          if (event.threadId !== threadRef.threadId) return;
          applyServerEvent(threadRef, event);
          if (event.type === "opened" || event.type === "closed") {
            refreshPreviewSessionState(threadRef);
          }
        },
        {
          onResubscribe: () => refreshPreviewSessionState(threadRef),
        },
      );
    };

    const unsubscribeConnections = subscribeEnvironmentConnections(attach);
    attach();
    return () => {
      unsubscribeConnections();
      unsubscribeEvents();
    };
  }, [applyServerEvent, threadRef]);
}
