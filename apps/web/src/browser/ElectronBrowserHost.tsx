"use client";

import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { FILL_PREVIEW_VIEWPORT } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "~/env";
import { useTheme } from "~/hooks/useTheme";
import { useActivePreviewSessions } from "~/previewStateStore";

import { readPreviewAnnotationTheme } from "./annotationTheme";
import { useBrowserPointerStore } from "./browserPointerStore";
import { HostedBrowserWebview } from "./HostedBrowserWebview";
import { previewRuntimeTabId } from "./previewRuntimeTabId";
import { findActivePreviewWebContentsId } from "./previewWebviewLookup";

export function ElectronBrowserHost() {
  const { resolvedTheme } = useTheme();
  const previewByThreadKey = useActivePreviewSessions();
  const sessions = useMemo(
    () =>
      Object.entries(previewByThreadKey).flatMap(([threadKey, previewState]) => {
        const threadRef = parseScopedThreadKey(threadKey);
        return threadRef
          ? Object.values(previewState.sessions).map((snapshot) => ({
              threadRef,
              snapshot,
              runtimeTabId: previewRuntimeTabId(
                threadRef,
                previewState.serverEpoch,
                snapshot.tabId,
              ),
              pictureInPicture:
                previewState.desktopByTabId[snapshot.tabId]?.pictureInPicture ?? false,
              zoomFactor: previewState.desktopByTabId[snapshot.tabId]?.zoomFactor ?? 1,
            }))
          : [];
      }),
    [previewByThreadKey],
  );
  const [retainedSessions, setRetainedSessions] = useState(sessions);
  const currentSessionIdsRef = useRef(new Set(sessions.map(({ runtimeTabId }) => runtimeTabId)));
  currentSessionIdsRef.current = new Set(sessions.map(({ runtimeTabId }) => runtimeTabId));
  const retirementTimersRef = useRef(new Map<string, number | null>());

  useEffect(() => {
    setRetainedSessions((previous) => {
      const merged = new Map(previous.map((session) => [session.runtimeTabId, session]));
      for (const session of sessions) merged.set(session.runtimeTabId, session);
      return Array.from(merged.values());
    });
  }, [sessions]);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    const removeRetired = (runtimeTabId: string) => {
      retirementTimersRef.current.delete(runtimeTabId);
      setRetainedSessions((current) =>
        currentSessionIdsRef.current.has(runtimeTabId)
          ? current
          : current.filter((session) => session.runtimeTabId !== runtimeTabId),
      );
    };
    const prepareRemoval = (runtimeTabId: string) => {
      if (currentSessionIdsRef.current.has(runtimeTabId)) {
        retirementTimersRef.current.delete(runtimeTabId);
        return;
      }
      const webContentsId = findActivePreviewWebContentsId(document, runtimeTabId);
      if (webContentsId === null) {
        removeRetired(runtimeTabId);
        return;
      }
      if (!preview.prepareWebviewRemoval) {
        removeRetired(runtimeTabId);
        return;
      }
      retirementTimersRef.current.set(runtimeTabId, null);
      void preview.prepareWebviewRemoval(runtimeTabId, webContentsId).then(
        () => {
          if (!currentSessionIdsRef.current.has(runtimeTabId)) {
            removeRetired(runtimeTabId);
            return;
          }
          const restore = () => {
            if (!currentSessionIdsRef.current.has(runtimeTabId)) {
              removeRetired(runtimeTabId);
              return;
            }
            if (findActivePreviewWebContentsId(document, runtimeTabId) !== webContentsId) {
              removeRetired(runtimeTabId);
              return;
            }
            retirementTimersRef.current.set(runtimeTabId, null);
            void preview.registerWebview(runtimeTabId, webContentsId).then(
              () => removeRetired(runtimeTabId),
              () => {
                const timerId = window.setTimeout(restore, 250);
                retirementTimersRef.current.set(runtimeTabId, timerId);
              },
            );
          };
          restore();
        },
        () => {
          const timerId = window.setTimeout(() => prepareRemoval(runtimeTabId), 250);
          retirementTimersRef.current.set(runtimeTabId, timerId);
        },
      );
    };
    for (const session of retainedSessions) {
      if (
        currentSessionIdsRef.current.has(session.runtimeTabId) ||
        retirementTimersRef.current.has(session.runtimeTabId)
      ) {
        continue;
      }
      prepareRemoval(session.runtimeTabId);
    }
  }, [retainedSessions]);

  useEffect(
    () => () => {
      for (const timerId of retirementTimersRef.current.values()) {
        if (timerId !== null) window.clearTimeout(timerId);
      }
      retirementTimersRef.current.clear();
    },
    [],
  );

  const displayedSessions = useMemo(() => {
    const byRuntimeTabId = new Map(
      retainedSessions.map((session) => [session.runtimeTabId, session]),
    );
    for (const session of sessions) byRuntimeTabId.set(session.runtimeTabId, session);
    return Array.from(byRuntimeTabId.values());
  }, [retainedSessions, sessions]);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;

    let lastSerializedTheme = "";
    const syncTheme = () => {
      const theme = readPreviewAnnotationTheme();
      const serializedTheme = JSON.stringify(theme);
      if (serializedTheme === lastSerializedTheme) return;
      lastSerializedTheme = serializedTheme;
      void preview.setAnnotationTheme(theme).catch(() => {
        lastSerializedTheme = "";
      });
    };
    const frameId = window.requestAnimationFrame(syncTheme);
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    const headObserver = new MutationObserver(syncTheme);
    headObserver.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
      headObserver.disconnect();
    };
  }, [resolvedTheme]);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    return preview.onPointerEvent((event) => {
      useBrowserPointerStore.getState().apply(event);
    });
  }, []);

  if (!isElectron) return null;
  return (
    <div className="contents" data-electron-browser-host>
      {displayedSessions.map(
        ({ threadRef, snapshot, runtimeTabId, pictureInPicture, zoomFactor }) => {
          const url = snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
          return (
            <HostedBrowserWebview
              key={runtimeTabId}
              threadRef={threadRef}
              tabId={snapshot.tabId}
              runtimeTabId={runtimeTabId}
              initialUrl={url}
              viewport={snapshot.viewport ?? FILL_PREVIEW_VIEWPORT}
              pictureInPicture={pictureInPicture}
              zoomFactor={zoomFactor}
            />
          );
        },
      )}
    </div>
  );
}
