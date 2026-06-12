"use client";

import type { DesktopPreviewWebviewConfig, ScopedThreadRef } from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";
import { useCallback, useEffect, useRef, useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { usePreviewBridge } from "~/components/preview/usePreviewBridge";

import { useBrowserRecordingStore } from "./browserRecording";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { acquireDesktopTab } from "./desktopTabLifetime";

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
  const [config, setConfig] = useState<DesktopPreviewWebviewConfig | null>(null);
  const initialSrcRef = useRef(initialUrl ?? "about:blank");
  const webviewRef = useRef<ElectronWebview | null>(null);
  const presentation = useBrowserSurfaceStore(useShallow((state) => state.byTabId[tabId] ?? null));
  const recording = useBrowserRecordingStore((state) => state.activeTabId === tabId);

  usePreviewBridge({ threadRef, tabId });

  useEffect(() => acquireDesktopTab(tabId), [tabId]);

  useEffect(() => {
    let cancelled = false;
    void previewBridge
      ?.getPreviewConfig(threadRef.environmentId)
      .then((next) => {
        if (!cancelled) setConfig(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [threadRef.environmentId]);

  const setWebviewRef = useCallback((node: HTMLElement | null) => {
    webviewRef.current = node as ElectronWebview | null;
    if (node && !node.hasAttribute("allowpopups")) node.setAttribute("allowpopups", "true");
  }, []);

  useEffect(() => {
    const webview = webviewRef.current;
    const bridge = previewBridge;
    if (!webview || !config || !bridge) return;
    const register = () => {
      try {
        const webContentsId = webview.getWebContentsId();
        if (Number.isInteger(webContentsId) && webContentsId > 0) {
          void bridge.registerWebview(tabId, webContentsId);
        }
      } catch {
        // A later dom-ready will retry registration.
      }
    };
    webview.addEventListener("dom-ready", register);
    register();
    return () => webview.removeEventListener("dom-ready", register);
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
