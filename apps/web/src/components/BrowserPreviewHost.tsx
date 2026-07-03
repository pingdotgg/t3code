import { scopeThreadRef } from "@t3tools/client-runtime";
import { previewPartitionForEnvironment } from "@t3tools/shared/preview";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { isElectron } from "~/env";
import {
  getDesktopPreviewBridge,
  statusFromWebview,
  type PreviewWebviewElement,
} from "~/previewWebview";
import {
  applyPreviewDesktopState,
  desktopPreviewNavStatusToPreviewNavStatus,
  findPreviewThreadRefByTabId,
  getPreviewSnapshotTitle,
  getPreviewSnapshotUrl,
  markPreviewTabClosed,
  type HostedPreviewSurface,
  useHostedPreviewSurfaces,
} from "~/previewStateStore";

function reportPreviewStatus(
  api: ReturnType<typeof readEnvironmentApi>,
  input: Parameters<
    NonNullable<ReturnType<typeof readEnvironmentApi>>["preview"]["reportStatus"]
  >[0],
): void {
  if (!api) {
    return;
  }
  void api.preview.reportStatus(input).catch((error: unknown) => {
    console.error("[BROWSER_PREVIEW] report status failed", error);
  });
}

export const BrowserPreviewHost = memo(function BrowserPreviewHost() {
  const surfaces = useHostedPreviewSurfaces();

  useEffect(() => {
    const previewBridge = getDesktopPreviewBridge();
    if (!previewBridge) {
      return;
    }

    return previewBridge.onStateChange((change) => {
      const threadRef =
        change.type === "closed"
          ? findPreviewThreadRefByTabId(change.tabId)
          : findPreviewThreadRefByTabId(change.state.tabId);
      if (!threadRef) {
        return;
      }

      if (change.type === "closed") {
        markPreviewTabClosed(threadRef, change.tabId);
        return;
      }

      applyPreviewDesktopState(threadRef, change.state);
      const api = readEnvironmentApi(threadRef.environmentId);
      if (!api) {
        return;
      }
      reportPreviewStatus(api, {
        threadId: threadRef.threadId,
        tabId: change.state.tabId,
        navStatus: desktopPreviewNavStatusToPreviewNavStatus(change.state),
        canGoBack: change.state.canGoBack,
        canGoForward: change.state.canGoForward,
      });
    });
  }, []);

  if (!isElectron || !getDesktopPreviewBridge()) {
    return null;
  }

  return (
    <>
      {surfaces.map((surface) => (
        <HostedPreviewWebview key={surface.snapshot.tabId} surface={surface} />
      ))}
    </>
  );
});

const HostedPreviewWebview = memo(function HostedPreviewWebview({
  surface,
}: {
  readonly surface: HostedPreviewSurface;
}) {
  const { threadRef, snapshot, rect } = surface;
  const environmentId = threadRef.environmentId;
  const threadId = threadRef.threadId;
  const stableThreadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const webviewRef = useRef<PreviewWebviewElement | null>(null);
  const api = useMemo(() => readEnvironmentApi(environmentId), [environmentId]);
  const activeUrl = getPreviewSnapshotUrl(snapshot);
  // The webview `src` must stay fixed for the life of the tab. Binding it to the
  // live (reported) URL makes every in-page navigation or redirect re-assign
  // `src`, which forces Electron to reload the guest — an infinite loop when a
  // page redirects. Explicit navigations are driven via previewBridge.navigate.
  const initialUrl = useRef(activeUrl).current;
  const partition = useMemo(() => previewPartitionForEnvironment(environmentId), [environmentId]);

  useEffect(() => {
    const previewBridge = getDesktopPreviewBridge();
    if (!previewBridge || !initialUrl) {
      return;
    }

    void previewBridge
      .createTab({ tabId: snapshot.tabId, url: initialUrl, partition })
      .then((state) => applyPreviewDesktopState(stableThreadRef, state))
      .catch((error: unknown) => {
        console.error("[BROWSER_PREVIEW] create tab failed", error);
      });
  }, [initialUrl, partition, snapshot.tabId, stableThreadRef]);

  const reportWebviewStatus = useCallback(
    (tag: "Loading" | "Success") => {
      if (!api || !activeUrl) {
        return;
      }
      const webview = webviewRef.current;
      reportPreviewStatus(api, {
        threadId,
        tabId: snapshot.tabId,
        navStatus: statusFromWebview(webview, activeUrl, tag),
        canGoBack: webview?.canGoBack?.() ?? snapshot.canGoBack,
        canGoForward: webview?.canGoForward?.() ?? snapshot.canGoForward,
      });
    },
    [activeUrl, api, snapshot.canGoBack, snapshot.canGoForward, snapshot.tabId, threadId],
  );

  const registerWebviewElement = useCallback(
    (element: HTMLElement | null) => {
      const webview = element as PreviewWebviewElement | null;
      webviewRef.current = webview;
      if (!webview) {
        return;
      }

      const previewBridge = getDesktopPreviewBridge();
      if (!previewBridge) {
        return;
      }

      const register = () => {
        const webContentsId = webview.getWebContentsId?.();
        if (typeof webContentsId !== "number") {
          return;
        }
        void previewBridge
          .registerWebview({ tabId: snapshot.tabId, webContentsId, partition })
          .then((state) => applyPreviewDesktopState(stableThreadRef, state))
          .catch((error: unknown) => {
            console.error("[BROWSER_PREVIEW] register webview failed", error);
          });
      };

      webview.addEventListener("did-attach", register, { once: true });
      queueMicrotask(register);
    },
    [partition, snapshot.tabId, stableThreadRef],
  );

  if (!initialUrl) {
    return null;
  }

  return (
    <webview
      ref={registerWebviewElement}
      src={initialUrl}
      title={getPreviewSnapshotTitle(snapshot)}
      partition={partition}
      allowpopups
      className="fixed z-20 bg-white"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
      }}
      onLoadStart={() => reportWebviewStatus("Loading")}
      onLoad={() => reportWebviewStatus("Success")}
    />
  );
});
