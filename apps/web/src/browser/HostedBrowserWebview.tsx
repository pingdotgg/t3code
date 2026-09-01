"use client";

import type { PreviewViewportSetting, ScopedThreadRef } from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";
import { useCallback, useEffect, useRef, useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { usePreviewBridge } from "~/components/preview/usePreviewBridge";
import { cn } from "~/lib/utils";

import { resolveBrowserSurfacePanelRect, useBrowserSurfaceStore } from "./browserSurfaceStore";
import { useActiveBrowserRecordingTabIds } from "./browserRecording";
import {
  browserViewportSettingKey,
  resolveBrowserViewportLayout,
  resolveFittedBrowserViewport,
} from "./browserViewportLayout";
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

interface RetiredCaptureWebview {
  readonly generation: number;
  readonly src: string;
  readonly webContentsId: number;
}

declare global {
  interface HTMLElementTagNameMap {
    webview: ElectronWebview;
  }
}

export function hostedBrowserCompositingLayoutKey(layout: {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly viewportScale: number;
}) {
  return `${layout.viewportWidth}:${layout.viewportHeight}:${layout.viewportScale}`;
}

export function hostedBrowserWebviewRenderEntries(
  retired: ReadonlyArray<Pick<RetiredCaptureWebview, "generation" | "src">>,
  live: { readonly generation: number; readonly src: string },
) {
  return [
    ...retired.map((entry) => ({ ...entry, retired: true as const })),
    { ...live, retired: false as const },
  ];
}

export function HostedBrowserWebview(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly runtimeTabId: string;
  readonly initialUrl: string | null;
  readonly viewport: PreviewViewportSetting;
  readonly pictureInPicture: boolean;
  readonly zoomFactor: number;
}) {
  const { threadRef, tabId, runtimeTabId, initialUrl, viewport, pictureInPicture, zoomFactor } =
    props;
  const config = usePreviewWebviewConfig(threadRef.environmentId);
  const [initialSrc] = useState(() => initialUrl ?? "about:blank");
  const tabLeaseRef = useRef<AcquiredDesktopTab | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<ElectronWebview | null>(null);
  const crashRecoveryRef = useRef<WebviewCrashRecoveryState>(INITIAL_WEBVIEW_CRASH_RECOVERY_STATE);
  const [aspectRatioLocked, setAspectRatioLocked] = useState(false);
  const [compositingReady, setCompositingReady] = useState(false);
  const [registeredGeneration, setRegisteredGeneration] = useState<number | null>(null);
  const presentation = useBrowserSurfaceStore(
    useShallow((state) => {
      const current = state.byTabId[runtimeTabId];
      return {
        content: current?.content ?? null,
        cornerRadius: current?.cornerRadius ?? 0,
        fitSourceContent: current?.fitSourceContent ?? false,
        fittedSourceContent: current?.fittedSourceContent ?? null,
        rect: resolveBrowserSurfacePanelRect(state.byTabId, runtimeTabId),
        visible: current?.visible ?? false,
      };
    }),
  );
  const backgroundActivity = useBrowserSurfaceStore(
    (state) => (state.activityByTabId[runtimeTabId] ?? 0) > 0,
  );
  const recordingActive = useActiveBrowserRecordingTabIds().has(runtimeTabId);
  usePreviewBridge({ threadRef, tabId, runtimeTabId });

  useEffect(() => {
    crashRecoveryRef.current = INITIAL_WEBVIEW_CRASH_RECOVERY_STATE;
    const lease = acquireDesktopTab(runtimeTabId);
    tabLeaseRef.current = lease;
    return () => {
      if (tabLeaseRef.current === lease) tabLeaseRef.current = null;
      lease.release();
    };
  }, [runtimeTabId]);

  const [webviewGeneration, setWebviewGeneration] = useState(0);
  const [recoverySrc, setRecoverySrc] = useState(initialSrc);
  const [retiredCaptureWebviews, setRetiredCaptureWebviews] = useState<
    ReadonlyArray<RetiredCaptureWebview>
  >([]);
  const captureRetirementTimersRef = useRef(new Map<number, number | null>());
  const latestUrlRef = useRef(initialUrl);

  useEffect(() => {
    latestUrlRef.current = initialUrl;
  }, [initialUrl]);

  const prepareRetiredCaptureWebview = useCallback(
    (webContentsId: number) => {
      const prepareWebviewRemoval = previewBridge?.prepareWebviewRemoval;
      if (captureRetirementTimersRef.current.has(webContentsId)) return;
      if (!prepareWebviewRemoval) {
        setRetiredCaptureWebviews((current) =>
          current.filter((candidate) => candidate.webContentsId !== webContentsId),
        );
        return;
      }
      const prepare = () => {
        captureRetirementTimersRef.current.set(webContentsId, null);
        void prepareWebviewRemoval(runtimeTabId, webContentsId).then(
          () => {
            captureRetirementTimersRef.current.delete(webContentsId);
            setRetiredCaptureWebviews((current) =>
              current.filter((candidate) => candidate.webContentsId !== webContentsId),
            );
          },
          () => {
            const timerId = window.setTimeout(prepare, 250);
            captureRetirementTimersRef.current.set(webContentsId, timerId);
          },
        );
      };
      prepare();
    },
    [runtimeTabId],
  );

  useEffect(
    () => () => {
      for (const timerId of captureRetirementTimersRef.current.values()) {
        if (timerId !== null) window.clearTimeout(timerId);
      }
      captureRetirementTimersRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    const bridge = previewBridge;
    if (!bridge?.onCaptureRecovery) return;
    return bridge.onCaptureRecovery((recovery) => {
      const webview = webviewRef.current;
      if (recovery.tabId !== runtimeTabId || !webview) {
        return;
      }
      try {
        if (webview.getWebContentsId() !== recovery.webContentsId) return;
      } catch {
        return;
      }
      setCompositingReady(false);
      setRetiredCaptureWebviews((current) =>
        current.some((candidate) => candidate.webContentsId === recovery.webContentsId)
          ? current
          : [
              ...current,
              {
                generation: webviewGeneration,
                src: webviewGeneration === 0 ? initialSrc : recoverySrc,
                webContentsId: recovery.webContentsId,
              },
            ],
      );
      prepareRetiredCaptureWebview(recovery.webContentsId);
      setRecoverySrc(latestUrlRef.current ?? initialSrc);
      setWebviewGeneration((generation) => generation + 1);
    });
  }, [initialSrc, prepareRetiredCaptureWebview, recoverySrc, runtimeTabId, webviewGeneration]);

  const setWebviewRef = useCallback((node: HTMLElement | null) => {
    if (node) webviewRef.current = node as ElectronWebview;
  }, []);

  useEffect(() => {
    const webview = webviewRef.current;
    const bridge = previewBridge;
    if (!webview || !config || !bridge) return;
    let disposed = false;
    let recoveryTimeout: ReturnType<typeof setTimeout> | null = null;
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
            if (!disposed && webviewRef.current === webview) {
              setRegisteredGeneration(webviewGeneration);
            }
          }
        } catch {
          // did-attach/dom-ready will retry if the guest was not ready yet.
        }
      })();
    };
    const recoverGuest = () => {
      if (disposed || recoveryTimeout !== null) return;
      const recovery = planWebviewCrashRecovery(crashRecoveryRef.current, Date.now());
      if (!recovery) return;
      crashRecoveryRef.current = recovery.state;
      recoveryTimeout = setTimeout(() => {
        recoveryTimeout = null;
        if (!disposed) {
          setRecoverySrc(latestUrlRef.current ?? initialSrc);
          setWebviewGeneration((generation) => generation + 1);
        }
      }, recovery.delayMs);
    };
    webview.addEventListener("did-attach", register);
    webview.addEventListener("dom-ready", register);
    webview.addEventListener("render-process-gone", recoverGuest);
    register();
    return () => {
      disposed = true;
      if (recoveryTimeout !== null) clearTimeout(recoveryTimeout);
      webview.removeEventListener("did-attach", register);
      webview.removeEventListener("dom-ready", register);
      webview.removeEventListener("render-process-gone", recoverGuest);
    };
  }, [config, initialSrc, runtimeTabId, webviewGeneration]);

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
  const hiddenContentSize = presentation.content
    ? {
        width: presentation.content.width / presentation.content.scale,
        height: presentation.content.height / presentation.content.scale,
      }
    : null;
  const hiddenSize =
    viewport._tag !== "fill"
      ? {
          width: viewport.width * normalizedZoomFactor,
          height: viewport.height * normalizedZoomFactor,
        }
      : {
          width: hiddenContentSize?.width ?? lastRect?.width ?? 1280,
          height: hiddenContentSize?.height ?? lastRect?.height ?? 800,
        };
  const containerSize = active && lastRect ? lastRect : hiddenSize;
  const deviceToolbarVisible = active && viewport._tag !== "fill" && !presentation.fitSourceContent;
  const {
    activeDrag,
    commitViewportChange,
    effectiveViewport,
    handleResizeKeyDown,
    handleResizePointerDown,
    layout: viewportLayout,
  } = useBrowserViewportResize({
    tabId: runtimeTabId,
    viewport,
    zoomFactor,
    containerSize,
    deviceToolbarVisible,
    aspectRatio: lockedAspectRatio,
  });
  const fittedSourceViewport =
    presentation.fitSourceContent && lastRect
      ? resolveFittedBrowserViewport(
          viewport,
          presentation.fittedSourceContent,
          normalizedZoomFactor,
        )
      : null;
  const layout =
    fittedSourceViewport && lastRect
      ? resolveBrowserViewportLayout(lastRect, fittedSourceViewport, normalizedZoomFactor)
      : viewportLayout;

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

  const renderingActive = active || backgroundActivity || pictureInPicture || recordingActive;
  const wrapperStyle = resolveHostedBrowserWebviewWrapperStyle({
    active,
    renderingActive,
    cornerRadius: presentation.cornerRadius,
    rect: lastRect,
    hiddenSize,
  });
  const compositingLayoutKey = hostedBrowserCompositingLayoutKey(layout);

  useEffect(() => {
    setCompositingReady(false);
    if (!renderingActive) return;
    let secondFrameId: number | null = null;
    let fallbackId: number | null = window.setTimeout(() => {
      fallbackId = null;
      setCompositingReady(true);
    }, 250);
    const firstFrameId = window.requestAnimationFrame(() => {
      secondFrameId = window.requestAnimationFrame(() => {
        secondFrameId = null;
        if (fallbackId !== null) window.clearTimeout(fallbackId);
        fallbackId = null;
        setCompositingReady(true);
      });
    });
    return () => {
      if (fallbackId !== null) window.clearTimeout(fallbackId);
      window.cancelAnimationFrame(firstFrameId);
      if (secondFrameId !== null) window.cancelAnimationFrame(secondFrameId);
    };
  }, [
    renderingActive,
    compositingLayoutKey,
    webviewGeneration,
    wrapperStyle.height,
    wrapperStyle.left,
    wrapperStyle.top,
    wrapperStyle.visibility,
    wrapperStyle.width,
  ]);

  if (!config) return null;

  const renderWebview = (generation: number, src: string, retired: boolean) => (
    <webview
      key={generation}
      ref={retired ? undefined : setWebviewRef}
      // Must be an attribute on the element itself: Electron reads it when the
      // guest attaches, so setting it from the ref callback lands too late and
      // the guest attaches with popups disabled. React types `allowpopups` as a
      // boolean, but react-dom drops boolean values for unrecognized attributes,
      // so the literal string has to be spread past the type.
      {...({ allowpopups: "true" } as unknown as { readonly allowpopups?: boolean })}
      src={src}
      partition={config.partition}
      webpreferences={config.webPreferences}
      {...(config.preloadUrl ? { preload: config.preloadUrl } : {})}
      data-preview-tab={runtimeTabId}
      data-preview-server-tab={tabId}
      data-preview-viewport-mode={effectiveViewport._tag}
      data-preview-viewport-key={browserViewportSettingKey(effectiveViewport)}
      data-preview-css-width={
        fittedSourceViewport
          ? fittedSourceViewport.width
          : effectiveViewport._tag === "fill"
            ? Math.max(1, Math.round(layout.viewportWidth / normalizedZoomFactor))
            : effectiveViewport.width
      }
      data-preview-css-height={
        fittedSourceViewport
          ? fittedSourceViewport.height
          : effectiveViewport._tag === "fill"
            ? Math.max(1, Math.round(layout.viewportHeight / normalizedZoomFactor))
            : effectiveViewport.height
      }
      data-preview-capture-retired={retired ? "true" : undefined}
      aria-hidden={retired || !active ? true : undefined}
      className={cn(
        "absolute flex overflow-hidden bg-background",
        !retired && active && !layout.fillsPanel && "ring-1 ring-border/70 shadow-sm",
      )}
      style={{
        left: layout.viewportX,
        top: layout.viewportY,
        width: layout.viewportWidth / layout.viewportScale,
        height: layout.viewportHeight / layout.viewportScale,
        transform: layout.viewportScale < 1 ? `scale(${layout.viewportScale})` : undefined,
        transformOrigin: "top left",
        pointerEvents: retired ? "none" : undefined,
      }}
    />
  );

  return (
    <div
      ref={wrapperRef}
      className="fixed overflow-hidden bg-muted/35"
      style={{ ...wrapperStyle, overscrollBehavior: "contain" }}
      onScroll={syncContentPresentation}
      data-preview-rendering={renderingActive ? "active" : "suspended"}
      data-preview-compositing={
        compositingReady && registeredGeneration === webviewGeneration ? "ready" : "pending"
      }
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
        {hostedBrowserWebviewRenderEntries(retiredCaptureWebviews, {
          generation: webviewGeneration,
          src: webviewGeneration === 0 ? initialSrc : recoverySrc,
        }).map((entry) => renderWebview(entry.generation, entry.src, entry.retired))}
        {active && effectiveViewport._tag !== "fill" && !fittedSourceViewport ? (
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
