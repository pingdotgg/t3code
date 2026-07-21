"use client";

import type { ScopedThreadRef } from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";
import { useCallback, useEffect, useRef } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { usePreviewBridge } from "~/components/preview/usePreviewBridge";

import { useActiveBrowserRecordingTabId } from "./browserRecording";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { acquireDesktopTab, type AcquiredDesktopTab } from "./desktopTabLifetime";
import { usePreviewWebviewConfig } from "./previewWebviewConfigState";

interface ElectronWebview extends HTMLElement {
  src: string;
  partition: string;
  preload?: string;
  webpreferences?: string;
  getWebContentsId: () => number;
}

declare global {
  interface HTMLElementTagNameMap {
    webview: ElectronWebview;
  }
}

export function HostedBrowserWebview(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly initialUrl: string | null;
}) {
  const { threadRef, tabId, initialUrl } = props;
  const config = usePreviewWebviewConfig(threadRef.environmentId);
  const initialSrcRef = useRef(initialUrl ?? "about:blank");
  const tabLeaseRef = useRef<AcquiredDesktopTab | null>(null);
  const webviewRef = useRef<ElectronWebview | null>(null);
  const presentation = useBrowserSurfaceStore(useShallow((state) => state.byTabId[tabId] ?? null));
  const recording = useActiveBrowserRecordingTabId() === tabId;

  usePreviewBridge({ threadRef, tabId });

  useEffect(() => {
    const lease = acquireDesktopTab(tabId);
    tabLeaseRef.current = lease;
    return () => {
      if (tabLeaseRef.current === lease) tabLeaseRef.current = null;
      lease.release();
    };
  }, [tabId]);

  const setWebviewRef = useCallback((node: HTMLElement | null) => {
    webviewRef.current = node as ElectronWebview | null;
    if (node && !node.hasAttribute("allowpopups")) node.setAttribute("allowpopups", "true");
  }, []);

  useEffect(() => {
    const webview = webviewRef.current;
    const bridge = previewBridge;
    if (!webview || !config || !bridge) return;
    let disposed = false;
    const register = () => {
      const lease = tabLeaseRef.current;
      if (!lease) return;
      void (async () => {
        try {
          // The main-process tab and the DOM webview are created by separate
          // effects. Wait for the former so registration cannot race and fail
          // with PreviewTabNotFoundError on a fast about:blank attachment.
          await lease.ready;
          if (disposed || webviewRef.current !== webview) return;
          const webContentsId = webview.getWebContentsId();
          if (Number.isInteger(webContentsId) && webContentsId > 0) {
            await bridge.registerWebview(tabId, webContentsId);
          }
        } catch {
          // did-attach/dom-ready will retry if the guest was not ready yet.
        }
      })();
    };
    webview.addEventListener("did-attach", register);
    webview.addEventListener("dom-ready", register);
    register();
    return () => {
      disposed = true;
      webview.removeEventListener("did-attach", register);
      webview.removeEventListener("dom-ready", register);
    };
  }, [config, tabId]);

  if (!config) return null;
  const active = presentation?.visible === true && presentation.rect !== null;
  const lastRect = presentation?.rect;
  const style =
    active && lastRect
      ? {
          left: lastRect.x,
          top: lastRect.y,
          width: lastRect.width,
          height: lastRect.height,
          zIndex: 30,
          pointerEvents: "auto" as const,
        }
      : {
          left: 0,
          top: 0,
          width: lastRect?.width ?? 1280,
          height: lastRect?.height ?? 800,
          zIndex: recording ? 0 : -1,
          pointerEvents: "none" as const,
        };

  return (
    <webview
      ref={setWebviewRef}
      src={initialSrcRef.current}
      partition={config.partition}
      webpreferences={config.webPreferences}
      {...(config.preloadUrl ? { preload: config.preloadUrl } : {})}
      data-preview-tab={tabId}
      aria-hidden={active ? undefined : true}
      className="fixed flex overflow-hidden bg-background"
      style={style}
    />
  );
}
