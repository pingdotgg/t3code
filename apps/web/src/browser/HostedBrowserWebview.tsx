"use client";

import type { PreviewViewportSetting, ScopedThreadRef } from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";
import { useCallback, useEffect, useRef, useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { usePreviewBridge } from "~/components/preview/usePreviewBridge";
import { cn } from "~/lib/utils";

import { useActiveBrowserRecordingTabId } from "./browserRecording";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { browserViewportSettingKey } from "./browserViewportLayout";
import { BrowserDeviceToolbar } from "./BrowserDeviceToolbar";
import { BrowserViewportResizeHandles } from "./BrowserViewportResizeHandles";
import { acquireDesktopTab, type AcquiredDesktopTab } from "./desktopTabLifetime";
import { usePreviewWebviewConfig } from "./previewWebviewConfigState";
import { useBrowserViewportResize } from "./useBrowserViewportResize";

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
  readonly initialUrl: string | null;
  readonly viewport: PreviewViewportSetting;
  readonly zoomFactor: number;
}) {
  const { threadRef, tabId, initialUrl, viewport, zoomFactor } = props;
  const config = usePreviewWebviewConfig(threadRef.environmentId);
  const [initialSrc] = useState(() => initialUrl ?? "about:blank");
  const tabLeaseRef = useRef<AcquiredDesktopTab | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<ElectronWebview | null>(null);
  const [lockedAspectRatio, setLockedAspectRatio] = useState<number | null>(null);
  const presentation = useBrowserSurfaceStore(
    useShallow((state) => {
      const current = state.byTabId[tabId];
      return {
        rect: current?.rect ?? null,
        visible: current?.visible ?? false,
      };
    }),
  );
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

  const active = presentation.visible && presentation.rect !== null;
  const lastRect = presentation.rect;
  const normalizedZoomFactor = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const viewportWidth = viewport._tag === "fill" ? null : viewport.width;
  const viewportHeight = viewport._tag === "fill" ? null : viewport.height;
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
    tabId,
    viewport,
    zoomFactor,
    containerSize,
    deviceToolbarVisible,
    aspectRatio: lockedAspectRatio,
  });

  const syncContentPresentation = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    useBrowserSurfaceStore.getState().presentContent(tabId, {
      x: layout.viewportX,
      y: layout.viewportY,
      width: layout.viewportWidth,
      height: layout.viewportHeight,
      scale: layout.viewportScale,
      scrollLeft: wrapper.scrollLeft,
      scrollTop: wrapper.scrollTop,
    });
  }, [layout, tabId]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(syncContentPresentation);
    return () => window.cancelAnimationFrame(frameId);
  }, [syncContentPresentation]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    wrapper.scrollTo({ left: 0, top: 0 });
  }, [tabId, viewport._tag, viewportHeight, viewportWidth]);

  if (!config) return null;

  const wrapperStyle =
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
          width: hiddenSize.width,
          height: hiddenSize.height,
          zIndex: recording ? 0 : -1,
          pointerEvents: "none" as const,
        };

  return (
    <div
      ref={wrapperRef}
      className="fixed overflow-hidden bg-muted/35"
      style={{ ...wrapperStyle, overscrollBehavior: "contain" }}
      onScroll={syncContentPresentation}
      data-preview-viewport={tabId}
    >
      <div className="relative" style={{ width: layout.canvasWidth, height: layout.canvasHeight }}>
        {deviceToolbarVisible && effectiveViewport._tag !== "fill" ? (
          <BrowserDeviceToolbar
            setting={effectiveViewport}
            width={Math.max(1, Math.round(containerSize.width))}
            aspectRatio={lockedAspectRatio}
            onAspectRatioChange={setLockedAspectRatio}
            onChange={commitViewportChange}
          />
        ) : null}
        <webview
          ref={setWebviewRef}
          src={initialSrc}
          partition={config.partition}
          webpreferences={config.webPreferences}
          {...(config.preloadUrl ? { preload: config.preloadUrl } : {})}
          data-preview-tab={tabId}
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
