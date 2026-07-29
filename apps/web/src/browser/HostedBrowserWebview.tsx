"use client";

import type { PreviewViewportSetting, ScopedThreadRef } from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";
import { useCallback, useEffect, useRef, useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { usePreviewBridge } from "~/components/preview/usePreviewBridge";
import { cn } from "~/lib/utils";

import { stopBrowserRecording, useActiveBrowserRecordingTabId } from "./browserRecording";
import { resolveBrowserSurfacePanelRect, useBrowserSurfaceStore } from "./browserSurfaceStore";
import { browserViewportSettingKey } from "./browserViewportLayout";
import { BrowserDeviceToolbar } from "./BrowserDeviceToolbar";
import { BrowserViewportResizeHandles } from "./BrowserViewportResizeHandles";
import { acquireDesktopTab, type AcquiredDesktopTab } from "./desktopTabLifetime";
import { resolveHostedBrowserWebviewWrapperStyle } from "./hostedBrowserWebviewStyle";
import { usePreviewWebviewConfig } from "./previewWebviewConfigState";
import { useBrowserViewportResize } from "./useBrowserViewportResize";
import {
  INITIAL_WEBVIEW_CRASH_RECOVERY_STATE,
  planWebviewCrashRecovery,
  type WebviewCrashRecoveryState,
} from "./webviewCrashRecovery";

interface ElectronWebview extends HTMLElement {
  src: string;
  partition: string;
  preload?: string;
  webpreferences?: string;
  getWebContentsId: () => number;
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
}

declare global {
  interface HTMLElementTagNameMap {
    webview: ElectronWebview;
  }
}

export function HostedBrowserWebview(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  /** Desktop-scoped identity; see previewRuntimeTabId. */
  readonly runtimeTabId: string;
  readonly initialUrl: string | null;
  readonly viewport: PreviewViewportSetting;
  readonly zoomFactor: number;
}) {
  const { threadRef, tabId, runtimeTabId, initialUrl, viewport, zoomFactor } = props;
  const config = usePreviewWebviewConfig(threadRef.environmentId);
  const [initialSrc] = useState(() => initialUrl ?? "about:blank");
  const tabLeaseRef = useRef<AcquiredDesktopTab | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<ElectronWebview | null>(null);
  const crashRecoveryRef = useRef<WebviewCrashRecoveryState>(INITIAL_WEBVIEW_CRASH_RECOVERY_STATE);
  const [aspectRatioLocked, setAspectRatioLocked] = useState(false);
  const activeRecordingTabId = useActiveBrowserRecordingTabId();
  const presentation = useBrowserSurfaceStore(
    useShallow((state) => {
      const current = state.byTabId[runtimeTabId];
      return {
        rect: resolveBrowserSurfacePanelRect(state.byTabId, runtimeTabId),
        visible: current?.visible ?? false,
      };
    }),
  );
  usePreviewBridge({ threadRef, tabId, runtimeTabId });

  useEffect(() => {
    if (presentation.visible || activeRecordingTabId !== runtimeTabId) return;
    void stopBrowserRecording(runtimeTabId).catch(() => undefined);
  }, [activeRecordingTabId, presentation.visible, runtimeTabId]);

  useEffect(() => {
    crashRecoveryRef.current = INITIAL_WEBVIEW_CRASH_RECOVERY_STATE;
    const lease = acquireDesktopTab(runtimeTabId);
    tabLeaseRef.current = lease;
    return () => {
      if (tabLeaseRef.current === lease) tabLeaseRef.current = null;
      lease.release();
    };
  }, [runtimeTabId]);

  // Remounting the guest is the only way to recover a dead render process, so
  // recovery bumps a generation key. The reload target tracks the tab's latest
  // URL rather than the URL it was first mounted with.
  const [webviewGeneration, setWebviewGeneration] = useState(0);
  const [recoverySrc, setRecoverySrc] = useState(initialSrc);
  const latestUrlRef = useRef(initialUrl);
  const hasConfig = config !== null;

  useEffect(() => {
    latestUrlRef.current = initialUrl;
  }, [initialUrl]);

  const setWebviewRef = useCallback((node: HTMLElement | null) => {
    webviewRef.current = node as ElectronWebview | null;
    if (node && !node.hasAttribute("allowpopups")) node.setAttribute("allowpopups", "true");
  }, []);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !hasConfig) return;
    let recoveryTimeout: ReturnType<typeof setTimeout> | null = null;
    const recoverGuest = () => {
      if (recoveryTimeout !== null) return;
      const recovery = planWebviewCrashRecovery(crashRecoveryRef.current, Date.now());
      if (!recovery) return;
      crashRecoveryRef.current = recovery.state;
      recoveryTimeout = setTimeout(() => {
        recoveryTimeout = null;
        setRecoverySrc(latestUrlRef.current ?? initialSrc);
        setWebviewGeneration((generation) => generation + 1);
      }, recovery.delayMs);
    };
    webview.addEventListener("render-process-gone", recoverGuest);
    return () => {
      if (recoveryTimeout !== null) clearTimeout(recoveryTimeout);
      webview.removeEventListener("render-process-gone", recoverGuest);
    };
  }, [hasConfig, initialSrc, webviewGeneration]);

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
            await bridge.registerWebview(runtimeTabId, webContentsId);
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
  }, [config, runtimeTabId, webviewGeneration]);

  const active = presentation.visible && presentation.rect !== null;
  const lastRect = presentation.rect;
  const normalizedZoomFactor = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const viewportWidth = viewport._tag === "fill" ? null : viewport.width;
  const viewportHeight = viewport._tag === "fill" ? null : viewport.height;
  const viewportAspectRatio =
    viewportWidth === null || viewportHeight === null ? null : viewportWidth / viewportHeight;
  const lockedAspectRatio =
    aspectRatioLocked && viewportAspectRatio !== null ? viewportAspectRatio : null;
  const handleAspectRatioChange = useCallback((aspectRatio: number | null) => {
    setAspectRatioLocked(aspectRatio !== null);
  }, []);
  const hiddenSize =
    viewport._tag !== "fill"
      ? {
          width: viewport.width * normalizedZoomFactor,
          height: viewport.height * normalizedZoomFactor,
        }
      : { width: lastRect?.width ?? 1280, height: lastRect?.height ?? 800 };
  const containerSize = active && lastRect ? lastRect : hiddenSize;
  const deviceToolbarVisible = active && viewport._tag !== "fill";
  const {
    activeDrag,
    commitViewportChange,
    effectiveViewport,
    handleResizeKeyDown,
    handleResizePointerDown,
    layout,
  } = useBrowserViewportResize({
    tabId: runtimeTabId,
    viewport,
    zoomFactor,
    containerSize,
    deviceToolbarVisible,
    aspectRatio: lockedAspectRatio,
  });

  const syncContentPresentation = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    useBrowserSurfaceStore.getState().presentContent(runtimeTabId, {
      x: layout.viewportX,
      y: layout.viewportY,
      width: layout.viewportWidth,
      height: layout.viewportHeight,
      scale: layout.viewportScale,
      scrollLeft: wrapper.scrollLeft,
      scrollTop: wrapper.scrollTop,
    });
  }, [layout, runtimeTabId]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(syncContentPresentation);
    return () => window.cancelAnimationFrame(frameId);
  }, [syncContentPresentation]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    wrapper.scrollTo({ left: 0, top: 0 });
  }, [runtimeTabId, viewport._tag, viewportHeight, viewportWidth]);

  if (!config) return null;

  const wrapperStyle = resolveHostedBrowserWebviewWrapperStyle({
    active,
    rect: lastRect,
    hiddenSize,
  });

  return (
    <div
      ref={wrapperRef}
      className="fixed overflow-hidden bg-muted/35"
      style={{ ...wrapperStyle, overscrollBehavior: "contain" }}
      onScroll={syncContentPresentation}
      data-preview-viewport={runtimeTabId}
    >
      <div className="relative" style={{ width: layout.canvasWidth, height: layout.canvasHeight }}>
        {deviceToolbarVisible && effectiveViewport._tag !== "fill" ? (
          <BrowserDeviceToolbar
            setting={effectiveViewport}
            width={Math.max(1, Math.round(containerSize.width))}
            aspectRatio={lockedAspectRatio}
            onAspectRatioChange={handleAspectRatioChange}
            onChange={commitViewportChange}
          />
        ) : null}
        <webview
          key={webviewGeneration}
          ref={setWebviewRef}
          src={webviewGeneration === 0 ? initialSrc : recoverySrc}
          partition={config.partition}
          webpreferences={config.webPreferences}
          {...(config.preloadUrl ? { preload: config.preloadUrl } : {})}
          data-preview-tab={runtimeTabId}
          data-preview-viewport-mode={effectiveViewport._tag}
          data-preview-viewport-key={browserViewportSettingKey(effectiveViewport)}
          data-preview-css-width={
            effectiveViewport._tag === "fill"
              ? Math.max(1, Math.round(layout.viewportWidth / normalizedZoomFactor))
              : effectiveViewport.width
          }
          data-preview-css-height={
            effectiveViewport._tag === "fill"
              ? Math.max(1, Math.round(layout.viewportHeight / normalizedZoomFactor))
              : effectiveViewport.height
          }
          aria-hidden={active ? undefined : true}
          className={cn(
            "absolute flex overflow-hidden bg-background",
            active && !layout.fillsPanel && "ring-1 ring-border/70 shadow-sm",
          )}
          style={{
            left: layout.viewportX,
            top: layout.viewportY,
            width: layout.viewportWidth / layout.viewportScale,
            height: layout.viewportHeight / layout.viewportScale,
            transform: layout.viewportScale < 1 ? `scale(${layout.viewportScale})` : undefined,
            transformOrigin: "top left",
          }}
        />
        {active && effectiveViewport._tag !== "fill" ? (
          <>
            <BrowserViewportResizeHandles
              layout={layout}
              activeDirection={activeDrag?.direction ?? null}
              onPointerDown={handleResizePointerDown}
              onKeyDown={handleResizeKeyDown}
            />
            {activeDrag ? (
              <div
                className="pointer-events-none absolute z-40 -translate-x-1/2 rounded-md border border-border/80 bg-background/95 px-2 py-1 text-[11px] font-medium tabular-nums text-foreground shadow-md backdrop-blur-sm"
                style={{
                  left: layout.viewportX + layout.viewportWidth / 2,
                  top: layout.viewportY + 10,
                }}
                aria-hidden="true"
              >
                {activeDrag.width} × {activeDrag.height}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
