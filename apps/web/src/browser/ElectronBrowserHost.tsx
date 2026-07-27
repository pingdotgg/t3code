"use client";

import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { FILL_PREVIEW_VIEWPORT } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import { isElectron } from "~/env";
import { useTheme } from "~/hooks/useTheme";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { removePreviewThread, useActivePreviewSessions } from "~/previewStateStore";
import { useThreadRefs } from "~/state/entities";

import { readPreviewAnnotationTheme } from "./annotationTheme";
import { useBrowserPointerStore } from "./browserPointerStore";
import { HostedBrowserWebview } from "./HostedBrowserWebview";
import { collectRemovedPreviewThreadRefs } from "./previewThreadLifecycle";

export function ElectronBrowserHost() {
  const { resolvedTheme } = useTheme();
  const previewByThreadKey = useActivePreviewSessions();
  const activeThreadRefs = useThreadRefs();
  const miniPlayerByThreadKey = usePreviewMiniPlayerStore((state) => state.byThreadKey);
  const previousActiveThreadRefs = useRef(activeThreadRefs);
  const sessions = useMemo(
    () =>
      Object.entries(previewByThreadKey).flatMap(([threadKey, previewState]) => {
        const threadRef = parseScopedThreadKey(threadKey);
        return threadRef
          ? Object.values(previewState.sessions).map((snapshot) => ({
              threadRef,
              snapshot,
              zoomFactor: previewState.desktopByTabId[snapshot.tabId]?.zoomFactor ?? 1,
            }))
          : [];
      }),
    [previewByThreadKey],
  );

  useEffect(() => {
    const removedThreadRefs = collectRemovedPreviewThreadRefs({
      previousActiveThreadRefs: previousActiveThreadRefs.current,
      activeThreadRefs,
      previewThreadKeys: Object.keys(previewByThreadKey),
      miniPlayerThreadKeys: Object.keys(miniPlayerByThreadKey),
    });
    previousActiveThreadRefs.current = activeThreadRefs;
    for (const threadRef of removedThreadRefs) {
      removePreviewThread(threadRef);
      usePreviewMiniPlayerStore.getState().removeThread(threadRef);
    }
  }, [activeThreadRefs, miniPlayerByThreadKey, previewByThreadKey]);

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
      {sessions.map(({ threadRef, snapshot, zoomFactor }) => {
        const url = snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
        return (
          <HostedBrowserWebview
            key={snapshot.tabId}
            threadRef={threadRef}
            tabId={snapshot.tabId}
            initialUrl={url}
            viewport={snapshot.viewport ?? FILL_PREVIEW_VIEWPORT}
            zoomFactor={zoomFactor}
          />
        );
      })}
    </div>
  );
}
