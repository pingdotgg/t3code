"use client";

import type { PreviewViewportSetting, ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useShallow } from "zustand/react/shallow";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { usePreviewBridge } from "~/components/preview/usePreviewBridge";
import { useClientSettingsHydrated } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";

import { resolveBrowserSurfacePanelRect, useBrowserSurfaceStore } from "./browserSurfaceStore";
import {
  BrowserRecordingUnavailableError,
  captureBrowserViewStream,
  useActiveBrowserRecordingTabIds,
} from "./browserRecording";
import {
  browserViewportSettingKey,
  resolveBrowserViewportLayout,
  resolveFittedBrowserViewport,
} from "./browserViewportLayout";
import { BrowserDeviceToolbar } from "./BrowserDeviceToolbar";
import { BrowserViewportResizeHandles } from "./BrowserViewportResizeHandles";
import { acquireDesktopTab } from "./desktopTabLifetime";
import { resolveHostedBrowserWebviewWrapperStyle } from "./hostedBrowserWebviewStyle";
import { useBrowserViewportResize } from "./useBrowserViewportResize";
const isBrowserRecordingUnavailableError = Schema.is(BrowserRecordingUnavailableError);

const browserModifiers = (
  event: Pick<MouseEvent, "shiftKey" | "ctrlKey" | "altKey" | "metaKey" | "buttons">,
) => {
  const modifiers: Array<
    "shift" | "control" | "alt" | "meta" | "leftbuttondown" | "middlebuttondown" | "rightbuttondown"
  > = [];
  if (event.shiftKey) modifiers.push("shift");
  if (event.ctrlKey) modifiers.push("control");
  if (event.altKey) modifiers.push("alt");
  if (event.metaKey) modifiers.push("meta");
  if (event.buttons & 1) modifiers.push("leftbuttondown");
  if (event.buttons & 2) modifiers.push("rightbuttondown");
  if (event.buttons & 4) modifiers.push("middlebuttondown");
  return modifiers;
};

export function HostedBrowserView(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly runtimeTabId: string;
  readonly initialUrl: string | null;
  readonly viewport: PreviewViewportSetting;
  readonly pictureInPicture: boolean;
  /**
   * Fixed for the tab's lifetime: moving a loaded page between profiles would
   * discard its session and document state.
   */
  readonly profileId: string | undefined;
  readonly zoomFactor: number;
}) {
  const { threadRef, tabId, runtimeTabId, viewport, pictureInPicture, zoomFactor, profileId } =
    props;
  const clientSettingsHydrated = useClientSettingsHydrated();
  const [initialUrl] = useState(props.initialUrl);
  const [mounted, setMounted] = useState(false);
  const [streamReady, setStreamReady] = useState(false);
  const [failedCaptureAttempt, setFailedCaptureAttempt] = useState<number | null>(null);
  const [captureAttempt, setCaptureAttempt] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const focusingFromPointer = useRef(false);
  const pressedButtons = useRef(new Map<number, number>());
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [aspectRatioLocked, setAspectRatioLocked] = useState(false);
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
        zIndex: current?.zIndex ?? 30,
      };
    }),
  );
  const backgroundActivity = useBrowserSurfaceStore(
    (state) => (state.activityByTabId[runtimeTabId] ?? 0) > 0,
  );
  const recordingActive = useActiveBrowserRecordingTabIds().has(runtimeTabId);
  usePreviewBridge({ threadRef, tabId, runtimeTabId });

  useEffect(() => {
    if (!clientSettingsHydrated) return;
    let disposed = false;
    const lease = acquireDesktopTab(runtimeTabId);
    void lease.ready
      .then(async () => {
        if (disposed) return;
        await previewBridge?.browser.mount(
          runtimeTabId,
          threadRef.environmentId,
          profileId,
          initialUrl,
        );
        if (!disposed) setMounted(true);
      })
      .catch(reportError);
    return () => {
      disposed = true;
      setMounted(false);
      lease.release();
    };
  }, [clientSettingsHydrated, runtimeTabId, threadRef.environmentId, profileId, initialUrl]);

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

  const renderingActive = active || backgroundActivity || pictureInPicture || recordingActive;

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
    const video = videoRef.current;
    if (mounted && video) {
      const panel = wrapper.getBoundingClientRect();
      const rect = video.getBoundingClientRect();
      const x = Math.max(panel.x, rect.x);
      const y = Math.max(panel.y, rect.y);
      const width = Math.min(panel.right, rect.right) - x;
      const height = Math.min(panel.bottom, rect.bottom) - y;
      const clip = active && width > 0 && height > 0 ? { x, y, width, height } : null;
      void previewBridge?.browser
        .layout(runtimeTabId, {
          rendering: renderingActive,
          viewport: {
            width: Math.max(1, layout.viewportWidth / layout.viewportScale / normalizedZoomFactor),
            height: Math.max(
              1,
              layout.viewportHeight / layout.viewportScale / normalizedZoomFactor,
            ),
          },
          clip,
          content: { x: rect.x - x, y: rect.y - y, scale: layout.viewportScale },
        })
        .catch(reportError);
    }
  }, [active, layout, mounted, normalizedZoomFactor, renderingActive, runtimeTabId]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(syncContentPresentation);
    return () => window.cancelAnimationFrame(frameId);
  }, [syncContentPresentation]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    wrapper.scrollTo({ left: 0, top: 0 });
  }, [runtimeTabId, viewport._tag, viewportHeight, viewportWidth]);

  useEffect(() => {
    if (!mounted || !active) return;
    let disposed = false;
    let stream: MediaStream | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const capture = () => {
      void captureBrowserViewStream(runtimeTabId)
        .then((captured) => {
          if (disposed) {
            captured.getTracks().forEach((track) => track.stop());
            return;
          }
          setFailedCaptureAttempt(null);
          stream = captured;
          captured.getVideoTracks()[0]?.addEventListener(
            "ended",
            () => {
              if (!disposed) setCaptureAttempt((attempt) => attempt + 1);
            },
            { once: true },
          );
          if (videoRef.current) videoRef.current.srcObject = captured;
        })
        .catch((error) => {
          if (disposed) return;
          if (!isBrowserRecordingUnavailableError(error) && ++failures < 3)
            retry = setTimeout(capture, failures * 250);
          else {
            setFailedCaptureAttempt(captureAttempt);
            reportError(error);
          }
        });
    };
    capture();
    return () => {
      disposed = true;
      clearTimeout(retry);
      setStreamReady(false);
      stream?.getTracks().forEach((track) => track.stop());
      if (videoRef.current?.srcObject === stream) videoRef.current.srcObject = null;
    };
  }, [active, mounted, runtimeTabId, captureAttempt]);

  useEffect(() => {
    const video = videoRef.current;
    const bridge = previewBridge;
    if (!mounted || !active || !video || !bridge) return;
    const point = (event: MouseEvent) => {
      const rect = video.getBoundingClientRect();
      return {
        x: event.clientX - rect.x,
        y: event.clientY - rect.y,
        modifiers: browserModifiers(event),
      };
    };
    const move = (event: PointerEvent) => {
      void bridge.browser
        .input(runtimeTabId, { type: "mouseMove", ...point(event) })
        .catch(reportError);
    };
    const leave = (event: PointerEvent) => {
      void bridge.browser
        .input(runtimeTabId, { type: "mouseLeave", ...point(event) })
        .catch(reportError);
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? video.clientHeight : 1;
      void bridge.browser
        .input(runtimeTabId, {
          type: "mouseWheel",
          ...point(event),
          deltaX: -event.deltaX * unit,
          deltaY: -event.deltaY * unit,
        })
        .catch(reportError);
    };
    const unsubscribe = bridge.browser.onCursorChange((tabId, cursor) => {
      if (tabId === runtimeTabId) video.style.cursor = cursor;
    });
    video.addEventListener("pointermove", move);
    video.addEventListener("pointerleave", leave);
    video.addEventListener("wheel", wheel, { passive: false });
    return () => {
      unsubscribe();
      video.removeEventListener("pointermove", move);
      video.removeEventListener("pointerleave", leave);
      video.removeEventListener("wheel", wheel);
    };
  }, [active, mounted, runtimeTabId]);

  const handlePointer = (event: ReactPointerEvent<HTMLVideoElement>) => {
    event.preventDefault();
    if (!mounted) return;
    const down = event.type === "pointerdown";
    if (event.button > 2) {
      if (down)
        void (
          event.button === 3
            ? previewBridge?.goBack(runtimeTabId)
            : previewBridge?.goForward(runtimeTabId)
        )?.catch(reportError);
      return;
    }
    const button = down
      ? event.button
      : (pressedButtons.current.get(event.pointerId) ?? event.button);
    if (!down) {
      pressedButtons.current.delete(event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (button < 0) return;
    if (down) {
      pressedButtons.current.set(event.pointerId, button);
      event.currentTarget.setPointerCapture(event.pointerId);
      // Keep DOM focus on the browser while the native page handles input.
      focusingFromPointer.current = true;
      event.currentTarget.focus({ preventScroll: true });
      focusingFromPointer.current = false;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    void previewBridge?.browser
      .input(runtimeTabId, {
        type: down ? "mouseDown" : "mouseUp",
        x: event.clientX - rect.x,
        y: event.clientY - rect.y,
        button: button === 2 ? "right" : button === 1 ? "middle" : "left",
        clickCount: Math.max(1, event.detail),
        modifiers: browserModifiers(event),
      })
      .catch(reportError);
  };

  if (!clientSettingsHydrated) return null;

  const wrapperStyle = resolveHostedBrowserWebviewWrapperStyle({
    active,
    renderingActive,
    keepPaintableWhenInactive: false,
    cornerRadius: presentation.cornerRadius,
    zIndex: presentation.zIndex,
    rect: lastRect,
    hiddenSize,
  });

  return (
    <div
      ref={wrapperRef}
      className="fixed overflow-hidden bg-muted/35"
      style={{ ...wrapperStyle, overscrollBehavior: "contain" }}
      onScroll={syncContentPresentation}
      data-preview-rendering={
        renderingActive && mounted && (!active || streamReady) ? "active" : "suspended"
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
        <video
          ref={videoRef}
          autoPlay
          onLoadedData={() => setStreamReady(true)}
          muted
          playsInline
          tabIndex={active && mounted ? 0 : -1}
          aria-label="Browser page"
          onPointerDown={handlePointer}
          onPointerUp={handlePointer}
          onPointerCancel={handlePointer}
          onContextMenu={(event) => event.preventDefault()}
          onFocus={(event) => {
            if (event.relatedTarget && !focusingFromPointer.current) {
              void previewBridge?.browser.input(runtimeTabId, null).catch(reportError);
            }
          }}
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
          aria-hidden={active ? undefined : true}
          className={cn(
            "absolute flex max-w-none overflow-hidden bg-white",
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
        {active && failedCaptureAttempt === captureAttempt ? (
          <button
            type="button"
            className="absolute inset-0 m-auto h-fit w-fit rounded-md border bg-background px-3 py-2 text-sm"
            onClick={() => setCaptureAttempt((attempt) => attempt + 1)}
          >
            Retry displaying page
          </button>
        ) : null}
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
