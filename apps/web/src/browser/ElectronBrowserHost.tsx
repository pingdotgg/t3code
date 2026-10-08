"use client";

import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { AuthPreviewOperateScope, FILL_PREVIEW_VIEWPORT } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { type ComponentProps, useEffect, useMemo, useRef } from "react";

import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import { isElectron } from "~/env";
import { useTheme } from "~/hooks/useTheme";
import { useActivePreviewSessions } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { readPreviewAnnotationTheme } from "./annotationTheme";
import { useBrowserPointerStore } from "./browserPointerStore";
import { HostedBrowserWebview } from "./HostedBrowserWebview";
import { openUrlInPreview } from "./openFileInPreview";
import { rendersServerTabNatively } from "./previewRuntime";
import { previewRuntimeTabId } from "./previewRuntimeTabId";

export function ElectronBrowserHost() {
  const { resolvedTheme } = useTheme();
  const previewByThreadKey = useActivePreviewSessions();
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const sessions = useMemo(
    () =>
      Object.entries(previewByThreadKey).flatMap(([threadKey, previewState]) => {
        const threadRef = parseScopedThreadKey(threadKey);
        // Server tabs of other environments stream; this desktop's own server tabs render here.
        return threadRef
          ? Object.values(previewState.sessions)
              .filter(
                (snapshot) =>
                  snapshot.runtime !== "server" ||
                  rendersServerTabNatively(threadRef.environmentId, primaryEnvironmentId, snapshot),
              )
              .map((snapshot) => ({
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
    [previewByThreadKey, primaryEnvironmentId],
  );

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

  // A `target="_blank"` link inside a hosted page opens as another tab of the
  // same thread, so the page that held the link stays where it is.
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: true });
  const sessionByRuntimeTabId = useRef(new Map<string, (typeof sessions)[number]>());
  useEffect(() => {
    sessionByRuntimeTabId.current = new Map(
      sessions.map((session) => [session.runtimeTabId, session]),
    );
  }, [sessions]);
  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    return preview.onOpenLink(({ tabId, url, background }) => {
      const source = sessionByRuntimeTabId.current.get(tabId);
      if (!source) return;
      // The new tab keeps the source tab's profile so its cookies carry over.
      void openUrlInPreview({
        threadRef: source.threadRef,
        url,
        openPreview,
        profileId: source.snapshot.profileId,
        background,
      });
    });
  }, [openPreview]);

  if (!isElectron) return null;
  return (
    <div className="contents" data-electron-browser-host>
      {sessions.map(({ threadRef, snapshot, runtimeTabId, pictureInPicture, zoomFactor }) => {
        const url = snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
        return (
          <AuthorizedBrowserWebview
            key={runtimeTabId}
            threadRef={threadRef}
            tabId={snapshot.tabId}
            runtimeTabId={runtimeTabId}
            initialUrl={url}
            viewport={snapshot.viewport ?? FILL_PREVIEW_VIEWPORT}
            pictureInPicture={pictureInPicture}
            profileId={snapshot.profileId}
            zoomFactor={zoomFactor}
            serverDriven={snapshot.runtime === "server"}
            {...(snapshot.runtime === "server"
              ? {
                  serverRendering: {
                    colorScheme: snapshot.colorScheme ?? "system",
                    zoomFactor: snapshot.zoomFactor ?? 1,
                  },
                }
              : {})}
          />
        );
      })}
    </div>
  );
}

function AuthorizedBrowserWebview(props: ComponentProps<typeof HostedBrowserWebview>) {
  const canOperatePreview = useEnvironmentScope(
    props.threadRef.environmentId,
    AuthPreviewOperateScope,
  );
  return canOperatePreview ? <HostedBrowserWebview {...props} /> : null;
}
