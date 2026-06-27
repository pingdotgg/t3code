"use client";

import type {
  DesktopPreviewSurfaceFrame,
  PreviewViewportSetting,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";
import { useCallback, useEffect, useRef, useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { usePreviewBridge } from "~/components/preview/usePreviewBridge";
import { resolveBrowserSurfacePanelRect, useBrowserSurfaceStore } from "./browserSurfaceStore";
import { browserViewportSettingKey } from "./browserViewportLayout";
import { reconcileLockedAspectRatio } from "./browserDeviceToolbarState";
import { BrowserDeviceToolbar } from "./BrowserDeviceToolbar";
import { BrowserViewportResizeHandles } from "./BrowserViewportResizeHandles";
import { acquireDesktopTab, type AcquiredDesktopTab } from "./desktopTabLifetime";
import {
  shouldPresentNativeSurface,
  subscribeToNativeSurfaceOcclusion,
} from "./nativeSurfaceOcclusion";
import { useBrowserViewportResize } from "./useBrowserViewportResize";

export function HostedBrowserWebview(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly initialUrl: string | null;
  readonly viewport: PreviewViewportSetting;
  readonly zoomFactor: number;
}) {
  const { threadRef, tabId, initialUrl, viewport, zoomFactor } = props;
  const tabLeaseRef = useRef<AcquiredDesktopTab | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const occlusionCaptureRequestedRef = useRef(false);
  const [lockedAspectRatio, setLockedAspectRatio] = useState<number | null>(null);
  const [surfaceOccluded, setSurfaceOccluded] = useState(false);
  const [occlusionFrame, setOcclusionFrame] = useState<DesktopPreviewSurfaceFrame | null>(null);
  const presentation = useBrowserSurfaceStore(
    useShallow((state) => {
      const current = state.byTabId[tabId];
      return {
        rect: resolveBrowserSurfacePanelRect(state.byTabId, tabId),
        visible: current?.visible ?? false,
      };
    }),
  );
  usePreviewBridge({ threadRef, tabId });

  useEffect(() => {
    const lease = acquireDesktopTab(tabId, threadRef.environmentId, initialUrl);
    tabLeaseRef.current = lease;
    return () => {
      if (tabLeaseRef.current === lease) tabLeaseRef.current = null;
      void previewBridge?.setSurface(tabId, { x: 0, y: 0, width: 1, height: 1 }, false, 1);
      lease.release();
    };
  }, [initialUrl, tabId, threadRef.environmentId]);

  const active = presentation.visible && presentation.rect !== null;
  const lastRect = presentation.rect;
  useEffect(() => {
    if (!active || !lastRect) return;
    return subscribeToNativeSurfaceOcclusion(lastRect, setSurfaceOccluded);
  }, [active, lastRect]);
  const presentNativeSurface = shouldPresentNativeSurface(
    active,
    surfaceOccluded,
    occlusionFrame !== null,
  );
  const normalizedZoomFactor = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const viewportWidth = viewport._tag === "fill" ? null : viewport.width;
  const viewportHeight = viewport._tag === "fill" ? null : viewport.height;
  const viewportAspectRatio =
    viewportWidth === null || viewportHeight === null ? null : viewportWidth / viewportHeight;
  useEffect(() => {
    setLockedAspectRatio((current) => reconcileLockedAspectRatio(current, viewportAspectRatio));
  }, [viewportAspectRatio]);
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
          left: -100_000,
          top: -100_000,
          width: hiddenSize.width,
          height: hiddenSize.height,
          zIndex: -1,
          pointerEvents: "none" as const,
          visibility: "hidden" as const,
        };

  useEffect(() => {
    if (!active || !surfaceOccluded) occlusionCaptureRequestedRef.current = false;
    const bridge = previewBridge;
    const lease = tabLeaseRef.current;
    if (!bridge || !lease) return;
    let cancelled = false;
    const bounds =
      active && lastRect
        ? {
            x: Math.round(lastRect.x + layout.viewportX),
            y: Math.round(lastRect.y + layout.viewportY),
            width: Math.max(1, Math.round(layout.viewportWidth)),
            height: Math.max(1, Math.round(layout.viewportHeight)),
          }
        : {
            x: 0,
            y: 0,
            width: Math.max(1, Math.round(layout.viewportWidth)),
            height: Math.max(1, Math.round(layout.viewportHeight)),
          };
    void lease.ready
      .then(async () => {
        if (cancelled) return;
        if (active && surfaceOccluded && !occlusionCaptureRequestedRef.current) {
          occlusionCaptureRequestedRef.current = true;
          const frame = await bridge.captureSurfaceFrame(tabId);
          if (cancelled) return;
          setOcclusionFrame(frame);
          return;
        }
        await bridge.setSurface(tabId, bounds, presentNativeSurface, layout.viewportScale);
        if (cancelled) return;
        if (!surfaceOccluded && presentNativeSurface) {
          setOcclusionFrame(null);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [active, lastRect, layout, presentNativeSurface, surfaceOccluded, tabId]);

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
        <div
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
          aria-hidden={!active}
          className="pointer-events-none absolute bg-background"
          style={{
            left: layout.viewportX,
            top: layout.viewportY,
            width: layout.viewportWidth / layout.viewportScale,
            height: layout.viewportHeight / layout.viewportScale,
            transform: layout.viewportScale < 1 ? `scale(${layout.viewportScale})` : undefined,
            transformOrigin: "top left",
          }}
        >
          {active && surfaceOccluded && occlusionFrame ? (
            <img
              alt=""
              aria-hidden="true"
              className="size-full"
              draggable={false}
              src={`data:${occlusionFrame.mimeType};base64,${occlusionFrame.data}`}
            />
          ) : null}
        </div>
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
