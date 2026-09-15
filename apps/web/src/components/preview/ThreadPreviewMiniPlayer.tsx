"use client";

import { FILL_PREVIEW_VIEWPORT, type ScopedThreadRef } from "@t3tools/contracts";
import { PanelRightIcon, PictureInPicture2, XIcon } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useAssetUrlState } from "~/assets/assetUrls";

import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import {
  findActiveBrowserRecordingRuntimeTabId,
  useActiveBrowserRecordingTabIds,
} from "~/browser/browserRecording";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import type { BrowserViewportResizeDirection } from "~/browser/browserViewportLayout";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useThreadPreviewState } from "~/previewStateStore";
import {
  type PreviewMiniPlayerSize,
  type PreviewMiniPlayerSource,
  type PreviewMiniPlayerState,
  previewMiniPlayerSourceKey,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { useCuaWindowPreview } from "~/state/cua";
import { useDeviceState } from "~/state/device";

import { DeviceStreamView } from "../device/DeviceStreamView";
import type { DeviceScreenSize } from "../device/deviceStream";
import { NativeAppIcon } from "../NativeAppIcon";
import type { ComputerUsePreview } from "./computerUsePreview";
import { previewBridge } from "./previewBridge";
import {
  clampPreviewMiniPlayerPosition,
  NO_PREVIEW_MINI_PLAYER_OBSTACLES,
  PREVIEW_MINI_PLAYER_CORNER_RADIUS,
  PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX,
  type PreviewMiniPlayerFrame,
  type PreviewMiniPlayerObstacles,
  resizePreviewMiniPlayer,
  resolveDeviceMiniPlayerCornerRadius,
  resolveDeviceMiniPlayerSourceSize,
  resolvePreviewMiniPlayerFrame,
  resolvePreviewMiniPlayerSourceSize,
} from "./previewMiniPlayerLayout";

interface PointerGesture {
  readonly pointerId: number;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly frame: PreviewMiniPlayerFrame;
  readonly direction: BrowserViewportResizeDirection | null;
}

interface Props {
  readonly threadRef: ScopedThreadRef;
  readonly miniPlayer: PreviewMiniPlayerState;
  /** The docked composer overlay; null while the composer floats mid-screen. */
  readonly composerOverlayElement: HTMLElement | null;
  /** The newest computer-use capture; only read by the computer source. */
  readonly computerUse?: ComputerUsePreview | null;
  readonly computerUseInProgress?: boolean;
}

interface Layout {
  readonly container: PreviewMiniPlayerSize;
  readonly obstacles: PreviewMiniPlayerObstacles;
}

const sameLayout = (a: Layout, b: Layout) =>
  a.container.width === b.container.width &&
  a.container.height === b.container.height &&
  (a.obstacles.composer === b.obstacles.composer ||
    (a.obstacles.composer !== null &&
      b.obstacles.composer !== null &&
      a.obstacles.composer.left === b.obstacles.composer.left &&
      a.obstacles.composer.right === b.obstacles.composer.right &&
      a.obstacles.composer.height === b.obstacles.composer.height));

/**
 * Measures the chat column and the composer in the column's coordinates. The
 * composer's columns come from its centered stack, not the full-width overlay,
 * so the margins beside it stay open to the player.
 */
function measureLayout(container: HTMLElement, composerOverlay: HTMLElement | null): Layout {
  const containerRect = container.getBoundingClientRect();
  const stackRect = composerOverlay
    ?.querySelector('[data-chat-composer-stack="true"]')
    ?.getBoundingClientRect();
  const overlayRect = composerOverlay?.getBoundingClientRect();
  return {
    container: { width: container.clientWidth, height: container.clientHeight },
    obstacles: {
      composer:
        overlayRect && stackRect && overlayRect.height > 0
          ? {
              left: Math.floor(stackRect.left - containerRect.left),
              right: Math.ceil(stackRect.right - containerRect.left),
              height: Math.ceil(overlayRect.height),
            }
          : null,
    },
  };
}

const frameCornerRadius = () => PREVIEW_MINI_PLAYER_CORNER_RADIUS;

// Invisible grab zones straddling each edge; the cursor is the only affordance.
const RESIZE_HANDLES: ReadonlyArray<{
  readonly direction: BrowserViewportResizeDirection;
  readonly className: string;
}> = [
  { direction: "north", className: "inset-x-0 -top-1 h-2 cursor-ns-resize" },
  { direction: "south", className: "inset-x-0 -bottom-1 h-2 cursor-ns-resize" },
  { direction: "west", className: "inset-y-0 -left-1 w-2 cursor-ew-resize" },
  { direction: "east", className: "inset-y-0 -right-1 w-2 cursor-ew-resize" },
  { direction: "northwest", className: "-left-2 -top-2 size-4 cursor-nwse-resize" },
  { direction: "northeast", className: "-right-2 -top-2 size-4 cursor-nesw-resize" },
  { direction: "southwest", className: "-bottom-2 -left-2 size-4 cursor-nesw-resize" },
  { direction: "southeast", className: "-bottom-2 -right-2 size-4 cursor-nwse-resize" },
];

/** Floats the thread's browser tab, device stream, or computer-use capture over chat. */
export function ThreadPreviewMiniPlayer({
  threadRef,
  miniPlayer,
  composerOverlayElement,
  computerUse = null,
  computerUseInProgress = false,
}: Props) {
  const { source } = miniPlayer;
  switch (source.kind) {
    case "browser":
      return (
        <BrowserMiniPlayer
          key={source.tabId}
          threadRef={threadRef}
          tabId={source.tabId}
          miniPlayer={miniPlayer}
          composerOverlayElement={composerOverlayElement}
        />
      );
    case "device":
      return (
        <DeviceMiniPlayer
          key={previewMiniPlayerSourceKey(source)}
          threadRef={threadRef}
          source={source}
          miniPlayer={miniPlayer}
          composerOverlayElement={composerOverlayElement}
        />
      );
    case "computer":
      return computerUse ? (
        <ComputerMiniPlayer
          key="computer"
          threadRef={threadRef}
          miniPlayer={miniPlayer}
          composerOverlayElement={composerOverlayElement}
          preview={computerUse}
          inProgress={computerUseInProgress}
        />
      ) : null;
  }
}

/**
 * What the agent is doing on the host desktop. While a turn is running the
 * server streams fresh captures of the window the agent targets; between
 * turns the card falls back to the last screenshot the agent itself took, so
 * it goes stale rather than blank. Mounting the card is what starts the
 * server-side capture loop, so a closed card costs the host nothing.
 */
function ComputerMiniPlayer({
  threadRef,
  miniPlayer,
  composerOverlayElement,
  preview,
  inProgress,
}: Props & { readonly preview: ComputerUsePreview; readonly inProgress: boolean }) {
  const live = useCuaWindowPreview(threadRef);
  const liveFrame = live.status === "live" ? (live.frame ?? null) : null;
  const liveSrc = useMemo(
    () => (liveFrame ? `data:${liveFrame.mimeType};base64,${liveFrame.dataBase64}` : null),
    [liveFrame],
  );
  const resource = useMemo(
    () => ({ _tag: "media-file", threadId: threadRef.threadId, path: preview.imagePath }) as const,
    [threadRef.threadId, preview.imagePath],
  );
  const asset = useAssetUrlState(threadRef.environmentId, resource);
  const [naturalSize, setNaturalSize] = useState<PreviewMiniPlayerSize | null>(null);
  const sourceSize =
    naturalSize ??
    (liveFrame && liveFrame.width > 0 && liveFrame.height > 0
      ? { width: liveFrame.width, height: liveFrame.height }
      : asset._tag === "Success" && asset.imageDimensions
        ? { width: asset.imageDimensions.width, height: asset.imageDimensions.height }
        : { width: 1280, height: 800 });
  const label = liveFrame?.appName ?? preview.appName ?? "Computer";
  const windowTitle = liveFrame?.windowTitle ?? preview.windowTitle;
  const caption = windowTitle && windowTitle !== label ? `${label} · ${windowTitle}` : label;
  const src = liveSrc ?? (asset._tag === "Success" ? asset.url : null);

  return (
    <MiniPlayerShell
      threadRef={threadRef}
      miniPlayer={miniPlayer}
      sourceSize={sourceSize}
      composerOverlayElement={composerOverlayElement}
      label="Floating computer use preview"
      recording={inProgress || live.status === "live"}
    >
      {() => (
        <div
          className="pointer-events-auto absolute inset-0 overflow-hidden rounded-[inherit] bg-muted"
          style={{ zIndex: PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX }}
        >
          {src ? (
            <img
              src={src}
              alt={caption}
              decoding="async"
              draggable={false}
              className="size-full select-none object-contain"
              onLoad={(event) => {
                const { naturalWidth, naturalHeight } = event.currentTarget;
                if (naturalWidth > 0 && naturalHeight > 0) {
                  setNaturalSize((current) =>
                    current?.width === naturalWidth && current.height === naturalHeight
                      ? current
                      : { width: naturalWidth, height: naturalHeight },
                  );
                }
              }}
            />
          ) : (
            <div className="flex size-full items-center justify-center text-xs text-muted-foreground">
              {asset._tag === "Failure" ? "Screenshot unavailable" : "Loading screenshot…"}
            </div>
          )}
          {live.status === "unavailable" && live.detail ? (
            <div className="pointer-events-none absolute inset-x-0 top-0 truncate bg-background/80 px-2.5 py-1 text-[11px] text-muted-foreground">
              Live preview unavailable: {live.detail}
            </div>
          ) : null}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-background/85 to-background/0 px-2.5 pb-2 pt-5 text-[11px] text-foreground">
            {preview.appIcon?.app._tag === "app-id" ? (
              <NativeAppIcon
                environmentId={threadRef.environmentId}
                bundleId={preview.appIcon.app.appId}
                className="size-3.5"
              />
            ) : null}
            <span className="truncate">{caption}</span>
          </div>
        </div>
      )}
    </MiniPlayerShell>
  );
}

function BrowserMiniPlayer({
  threadRef,
  tabId,
  miniPlayer,
  composerOverlayElement,
}: Props & { readonly tabId: string }) {
  const previewState = useThreadPreviewState(threadRef);
  const snapshot = previewState.sessions[tabId] ?? null;
  const runtimeTabId = previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId);
  const recordingTabIds = useActiveBrowserRecordingTabIds();
  const recording =
    recordingTabIds.has(runtimeTabId) ||
    findActiveBrowserRecordingRuntimeTabId(threadRef, tabId) !== null;
  const desktopOverlay = previewState.desktopByTabId[tabId] ?? null;
  const fittedSourceContent = useBrowserSurfaceStore(
    (state) => state.byTabId[runtimeTabId]?.fittedSourceContent ?? null,
  );
  const sourceSize = resolvePreviewMiniPlayerSourceSize(
    snapshot?.viewport ?? FILL_PREVIEW_VIEWPORT,
    fittedSourceContent,
    desktopOverlay?.zoomFactor ?? 1,
  );

  const openInPanel = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
    useRightPanelStore.getState().openBrowser(threadRef, tabId);
  };

  const toggleNativePictureInPicture = () => {
    if (!previewBridge) return;
    const operation = desktopOverlay?.pictureInPicture
      ? previewBridge.pictureInPicture.close
      : previewBridge.pictureInPicture.open;
    void operation(runtimeTabId).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to update popped-out preview",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  };

  if (!snapshot) return null;

  return (
    <MiniPlayerShell
      threadRef={threadRef}
      miniPlayer={miniPlayer}
      sourceSize={sourceSize}
      composerOverlayElement={composerOverlayElement}
      label="Floating browser preview"
      recording={recording}
      onOpenInPanel={openInPanel}
      pillActions={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant={desktopOverlay?.pictureInPicture ? "secondary" : "ghost"}
                size="icon-xs"
                aria-label={
                  desktopOverlay?.pictureInPicture
                    ? "Close popped-out preview"
                    : "Pop preview into separate window"
                }
                disabled={!desktopOverlay?.hasWebContents}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={toggleNativePictureInPicture}
              />
            }
          >
            <PictureInPicture2 />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {desktopOverlay?.pictureInPicture
              ? "Close separate window"
              : "Pop into separate window"}
          </TooltipPopup>
        </Tooltip>
      }
    >
      {(frame) => (
        <>
          <BrowserSurfaceSlot
            tabId={runtimeTabId}
            visible={Boolean(desktopOverlay?.hasWebContents)}
            cornerRadius={PREVIEW_MINI_PLAYER_CORNER_RADIUS}
            zIndex={PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX}
            fitSourceContent
            layoutVersion={`${frame.x}:${frame.y}`}
            className="absolute inset-0"
          />
          {!desktopOverlay?.hasWebContents ? (
            <div className="pointer-events-none absolute inset-0 z-[49] flex items-center justify-center rounded-[inherit] bg-muted text-xs text-muted-foreground">
              Reconnecting preview…
            </div>
          ) : null}
        </>
      )}
    </MiniPlayerShell>
  );
}

function DeviceMiniPlayer({
  threadRef,
  source,
  miniPlayer,
  composerOverlayElement,
}: Props & { readonly source: Extract<PreviewMiniPlayerSource, { kind: "device" }> }) {
  const { state: deviceState } = useDeviceState(threadRef.environmentId);
  const [screen, setScreen] = useState<DeviceScreenSize | null>(null);
  const sourceSize = resolveDeviceMiniPlayerSourceSize(source.platform, screen);
  const device = deviceState.devices.find(
    (entry) => entry.hostId === source.hostId && entry.id === source.deviceId,
  );
  const hostLabel =
    deviceState.hosts.find((host) => host.id === source.hostId)?.label ?? "Device host";
  const cornerRadius = useCallback(
    (player: PreviewMiniPlayerSize) => resolveDeviceMiniPlayerCornerRadius(source.platform, player),
    [source.platform],
  );

  const openInPanel = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
    useRightPanelStore.getState().openDevice(threadRef, {
      hostId: source.hostId,
      deviceId: source.deviceId,
      platform: source.platform,
      name: source.name,
    });
  };

  return (
    <MiniPlayerShell
      threadRef={threadRef}
      miniPlayer={miniPlayer}
      sourceSize={sourceSize}
      composerOverlayElement={composerOverlayElement}
      label="Floating device preview"
      onOpenInPanel={openInPanel}
      cornerRadius={cornerRadius}
    >
      {() => (
        // The stream is DOM, so it takes the band the browser's native webview would.
        <div
          className="pointer-events-auto absolute inset-0 overflow-hidden rounded-[inherit]"
          style={{ zIndex: PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX }}
        >
          <DeviceStreamView
            environmentId={threadRef.environmentId}
            platform={source.platform}
            deviceId={source.deviceId}
            hostId={source.hostId}
            deviceName={device?.name ?? source.name}
            deviceDescription={`${hostLabel} · ${device?.version ?? source.platform}`}
            visible
            onScreen={setScreen}
          />
        </div>
      )}
    </MiniPlayerShell>
  );
}

/**
 * The frame, drag/resize gestures, and hover pill shared by every floating
 * source. Native clipping and the DOM frame use the same radius so their
 * separately composited edges stay aligned.
 */
function MiniPlayerShell({
  threadRef,
  miniPlayer,
  sourceSize,
  composerOverlayElement,
  label,
  onOpenInPanel,
  pillActions,
  recording = false,
  cornerRadius = frameCornerRadius,
  children,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly miniPlayer: PreviewMiniPlayerState;
  readonly sourceSize: PreviewMiniPlayerSize;
  readonly composerOverlayElement: HTMLElement | null;
  readonly label: string;
  /** Omitted for sources with no right-panel equivalent. */
  readonly onOpenInPanel?: () => void;
  readonly pillActions?: ReactNode;
  readonly recording?: boolean;
  /** The clip radius for a given frame; the pill stays inside the curve. */
  readonly cornerRadius?: (frame: PreviewMiniPlayerSize) => number;
  readonly children: (frame: PreviewMiniPlayerFrame) => ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<PointerGesture | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const container = layout?.container ?? null;
  const obstacles = layout?.obstacles ?? NO_PREVIEW_MINI_PLAYER_OBSTACLES;
  const sourceKey = previewMiniPlayerSourceKey(miniPlayer.source);
  const frame = container
    ? resolvePreviewMiniPlayerFrame({
        width: miniPlayer.width,
        position: miniPlayer.position,
        source: sourceSize,
        container,
        obstacles,
      })
    : null;

  const radius = frame ? cornerRadius(frame) : PREVIEW_MINI_PLAYER_CORNER_RADIUS;
  // Inside a wide curve the default 8px inset would land on the clipped-away corner.
  const pillInset = Math.max(8, Math.round(radius * 0.55));

  const close = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
  };

  // The composer grows on its own (drafts, banners), so it is observed alongside the column.
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      const next = measureLayout(element, composerOverlayElement);
      setLayout((current) => (current && sameLayout(current, next) ? current : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (composerOverlayElement) observer.observe(composerOverlayElement);
    return () => observer.disconnect();
  }, [composerOverlayElement]);

  const beginGesture = (
    event: ReactPointerEvent<HTMLElement>,
    direction: BrowserViewportResizeDirection | null,
  ) => {
    if (event.button !== 0 || !frame) return;
    gestureRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      frame,
      direction,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || !container) return;
    const delta = { x: event.clientX - gesture.pointerX, y: event.clientY - gesture.pointerY };
    const store = usePreviewMiniPlayerStore.getState();
    if (gesture.direction === null) {
      store.move(
        threadRef,
        sourceKey,
        clampPreviewMiniPlayerPosition(
          { x: gesture.frame.x + delta.x, y: gesture.frame.y + delta.y },
          container,
          gesture.frame,
          obstacles,
        ),
      );
      return;
    }
    const next = resizePreviewMiniPlayer({
      start: gesture.frame,
      direction: gesture.direction,
      delta,
      source: sourceSize,
      container,
      obstacles,
    });
    store.resize(threadRef, sourceKey, next.width);
    store.move(threadRef, sourceKey, { x: next.x, y: next.y });
  };

  const endGesture = (event: ReactPointerEvent<HTMLElement>) => {
    if (gestureRef.current?.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0">
      {frame ? (
        <section
          aria-label={label}
          data-preview-mini-player={sourceKey}
          className="pointer-events-none absolute select-none"
          style={{
            left: frame.x,
            top: frame.y,
            width: frame.width,
            height: frame.height,
            borderRadius: radius,
          }}
        >
          <div
            className="group pointer-events-auto absolute z-[49] size-3"
            style={{ right: pillInset, top: pillInset }}
          >
            <div
              role={recording ? "status" : undefined}
              aria-label={recording ? "Recording preview" : undefined}
              aria-hidden={!recording}
              className="absolute right-0 top-0 size-2 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
            >
              <span
                className={cn(
                  "block size-2 rounded-full shadow-sm ring-1 ring-background/70",
                  recording ? "bg-red-500 motion-safe:animate-status-pulse" : "bg-foreground/25",
                )}
              />
            </div>
            <div
              className="pointer-events-none absolute right-0 top-0 flex h-8 cursor-grab items-center gap-0.5 rounded-lg border border-border/80 bg-popover/92 p-0.5 opacity-0 shadow-lg/20 backdrop-blur-xl transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 active:cursor-grabbing"
              onPointerDown={(event) => beginGesture(event, null)}
              onPointerMove={handlePointerMove}
              onPointerUp={endGesture}
              onPointerCancel={endGesture}
            >
              {recording ? (
                <span aria-hidden className="flex size-6 shrink-0 items-center justify-center">
                  <span className="size-2 rounded-full bg-red-500 motion-safe:animate-status-pulse" />
                </span>
              ) : null}
              {onOpenInPanel ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Open preview in right panel"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={onOpenInPanel}
                      />
                    }
                  >
                    <PanelRightIcon />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Open in right panel</TooltipPopup>
                </Tooltip>
              ) : null}
              {pillActions}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Close floating preview"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={close}
                    />
                  }
                >
                  <XIcon />
                </TooltipTrigger>
                <TooltipPopup side="top">Close floating preview</TooltipPopup>
              </Tooltip>
            </div>
          </div>

          <div className="absolute inset-0 z-[47] rounded-[inherit] bg-muted shadow-2xl/35" />
          {children(frame)}
          <div className="pointer-events-none absolute inset-0 z-[49] rounded-[inherit] ring-1 ring-inset ring-border/80" />
          {RESIZE_HANDLES.map(({ direction, className }) => (
            <div
              key={direction}
              role="presentation"
              data-preview-mini-player-resize={direction}
              className={cn("pointer-events-auto absolute z-[49] touch-none", className)}
              onPointerDown={(event) => beginGesture(event, direction)}
              onPointerMove={handlePointerMove}
              onPointerUp={endGesture}
              onPointerCancel={endGesture}
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}
