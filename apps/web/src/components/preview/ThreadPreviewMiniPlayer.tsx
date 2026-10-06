"use client";

import {
  type CuaWindowPreviewFrame,
  FILL_PREVIEW_VIEWPORT,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { PanelRightIcon, PictureInPicture2, XIcon } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useChatCanvas } from "../chat/ChatCanvasContext";
import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import {
  findActiveBrowserRecordingRuntimeTabId,
  useActiveBrowserRecordingTabIds,
} from "~/browser/browserRecording";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import type { BrowserViewportResizeDirection } from "~/browser/browserViewportLayout";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { useRendersServerTabNatively } from "~/browser/previewRuntime";
import { type ServerBrowserHandle, ServerBrowserSurface } from "~/browser/ServerBrowserSurface";
import {
  closeServerPictureInPicture,
  openServerPictureInPicture,
  serverPictureInPictureKey,
  supportsServerPictureInPicture,
  useServerPictureInPictureKey,
} from "~/browser/serverPictureInPicture";
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
import { useAssetUrlState } from "~/assets/assetUrls";

import { DeviceStreamView } from "../device/DeviceStreamView";
import type { DeviceScreenSize } from "@t3tools/client-runtime/device/stream";
import type { PreviewStreamViewport } from "@t3tools/client-runtime/preview/server-browser-stream";
import type { ComputerUsePreview } from "./computerUsePreview";
import { previewBridge } from "./previewBridge";
import {
  clampPreviewMiniPlayerPosition,
  NO_PREVIEW_MINI_PLAYER_OBSTACLES,
  PREVIEW_MINI_PLAYER_CORNER_RADIUS,
  PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX,
  type PreviewMiniPlayerFrame,
  resizePreviewMiniPlayer,
  resolveDeviceMiniPlayerCornerRadius,
  resolveDeviceMiniPlayerSourceSize,
  resolvePreviewMiniPlayerSourceSize,
} from "./previewMiniPlayerLayout";

interface PointerGesture {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly frame: PreviewMiniPlayerFrame;
  readonly direction: BrowserViewportResizeDirection | null;
  moved: boolean;
}

// A touch that travels less than this is a tap on the handle, not a drag.
const HANDLE_TAP_SLOP_PX = 6;

interface Props {
  readonly threadRef: ScopedThreadRef;
  readonly miniPlayer: PreviewMiniPlayerState;
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

/** Floats the thread's browser tab, device stream, or driven computer window over chat. */
export function ThreadPreviewMiniPlayer({
  threadRef,
  miniPlayer,
  computerUse = null,
}: Props & { readonly computerUse?: ComputerUsePreview | null }) {
  const { source } = miniPlayer;
  switch (source.kind) {
    case "browser":
      return (
        <BrowserMiniPlayer
          key={source.tabId}
          threadRef={threadRef}
          tabId={source.tabId}
          miniPlayer={miniPlayer}
        />
      );
    case "device":
      return (
        <DeviceMiniPlayer
          key={previewMiniPlayerSourceKey(source)}
          threadRef={threadRef}
          source={source}
          miniPlayer={miniPlayer}
        />
      );
    case "computer":
      return (
        <ComputerMiniPlayer threadRef={threadRef} miniPlayer={miniPlayer} preview={computerUse} />
      );
  }
}

/**
 * The window an agent drives on the host computer. While a computer use turn
 * runs, the server captures that window every second and a half and streams
 * it here; the capture runs only while this card is mounted. Between turns the
 * card keeps the last frame instead of going blank.
 */
function ComputerMiniPlayer({
  threadRef,
  miniPlayer,
  preview,
}: Props & { readonly preview: ComputerUsePreview | null }) {
  const live = useCuaWindowPreview(threadRef);
  const [lastFrame, setLastFrame] = useState<CuaWindowPreviewFrame | null>(null);
  const liveFrame = live.status === "live" ? (live.frame ?? null) : null;
  if (liveFrame !== null && liveFrame !== lastFrame) setLastFrame(liveFrame);
  const frame = liveFrame ?? lastFrame;
  const src = useMemo(
    () => (frame ? `data:${frame.mimeType};base64,${frame.dataBase64}` : null),
    [frame],
  );
  const sourceSize =
    frame && frame.width > 0 && frame.height > 0
      ? { width: frame.width, height: frame.height }
      : { width: 1280, height: 800 };
  const label = frame?.appName ?? preview?.appName ?? "Computer";
  const caption =
    frame?.windowTitle && frame.windowTitle !== label ? `${label} · ${frame.windowTitle}` : label;
  const appIcon = useAssetUrlState(
    threadRef.environmentId,
    preview?.app ? { _tag: "native-app-icon", app: preview.app } : null,
  );

  return (
    <MiniPlayerShell
      threadRef={threadRef}
      miniPlayer={miniPlayer}
      sourceSize={sourceSize}
      label="Floating computer use preview"
      recording={live.status === "live" || preview?.inProgress === true}
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
            />
          ) : (
            <div className="flex size-full items-center justify-center text-xs text-muted-foreground">
              {live.status === "unavailable" ? "Preview unavailable" : "Waiting for the agent…"}
            </div>
          )}
          {live.status === "unavailable" && live.detail ? (
            <div className="pointer-events-none absolute inset-x-0 top-0 truncate bg-background/80 px-2.5 py-1 text-2xs text-muted-foreground">
              {live.detail}
            </div>
          ) : null}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-background/85 to-background/0 px-2.5 pt-5 pb-2 text-2xs text-foreground">
            {appIcon._tag === "Success" ? (
              <img src={appIcon.url} alt="" aria-hidden className="size-3.5 shrink-0" />
            ) : null}
            <span className="truncate">{caption}</span>
          </div>
        </div>
      )}
    </MiniPlayerShell>
  );
}

function BrowserMiniPlayer({ threadRef, tabId, miniPlayer }: Props & { readonly tabId: string }) {
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
  const nativeServerTab = useRendersServerTabNatively(threadRef.environmentId, snapshot);
  const serverTab = snapshot?.runtime === "server" && !nativeServerTab;
  const [streamViewport, setStreamViewport] = useState<PreviewStreamViewport | null>(null);
  const serverSurfaceRef = useRef<ServerBrowserHandle | null>(null);
  const serverPictureInPicture =
    useServerPictureInPictureKey() === serverPictureInPictureKey(threadRef.threadId, tabId);
  const sourceSize =
    serverTab && streamViewport
      ? streamViewport
      : resolvePreviewMiniPlayerSourceSize(
          snapshot?.viewport ?? FILL_PREVIEW_VIEWPORT,
          fittedSourceContent,
          desktopOverlay?.zoomFactor ?? 1,
        );

  const openInPanel = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
    useRightPanelStore.getState().openBrowser(threadRef, tabId);
  };

  const toggleNativePictureInPicture = async () => {
    try {
      if (serverTab) {
        if (serverPictureInPicture) closeServerPictureInPicture();
        else
          await openServerPictureInPicture({
            ...threadRef,
            tabId,
            seed: serverSurfaceRef.current?.canvas() ?? null,
          });
      } else if (previewBridge) {
        const operation = desktopOverlay?.pictureInPicture
          ? previewBridge.pictureInPicture.close
          : previewBridge.pictureInPicture.open;
        await operation(runtimeTabId);
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: serverTab ? "Unable to pop out preview" : "Unable to update popped-out preview",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  };

  if (!snapshot) return null;
  const poppedOut = serverTab ? serverPictureInPicture : Boolean(desktopOverlay?.pictureInPicture);
  const canPopOut = serverTab ? supportsServerPictureInPicture() : true;

  return (
    <MiniPlayerShell
      threadRef={threadRef}
      miniPlayer={miniPlayer}
      sourceSize={sourceSize}
      label="Floating browser preview"
      recording={recording}
      onOpenInPanel={openInPanel}
      pillActions={
        canPopOut ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={poppedOut ? "secondary" : "ghost"}
                  size="icon-xs"
                  aria-label={
                    poppedOut ? "Close popped-out preview" : "Pop preview into separate window"
                  }
                  disabled={!serverTab && !desktopOverlay?.hasWebContents}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={toggleNativePictureInPicture}
                />
              }
            >
              <PictureInPicture2 />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {poppedOut ? "Close separate window" : "Pop into separate window"}
            </TooltipPopup>
          </Tooltip>
        ) : null
      }
    >
      {(frame) =>
        serverTab ? (
          <div
            className="pointer-events-auto absolute inset-0 overflow-hidden rounded-[inherit]"
            style={{ zIndex: PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX }}
          >
            <ServerBrowserSurface
              ref={serverSurfaceRef}
              environmentId={threadRef.environmentId}
              threadId={threadRef.threadId}
              tabId={tabId}
              visible
              followSize={false}
              controlPosition="bottom"
              onViewport={setStreamViewport}
              className="size-full"
            />
          </div>
        ) : (
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
        )
      }
    </MiniPlayerShell>
  );
}

function DeviceMiniPlayer({
  threadRef,
  source,
  miniPlayer,
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
  readonly label: string;
  /** Omitted for sources that have no panel, such as the computer card. */
  readonly onOpenInPanel?: () => void;
  readonly pillActions?: ReactNode;
  readonly recording?: boolean;
  /** The clip radius for a given frame; the pill stays inside the curve. */
  readonly cornerRadius?: (frame: PreviewMiniPlayerSize) => number;
  readonly children: (frame: PreviewMiniPlayerFrame) => ReactNode;
}) {
  const canvas = useChatCanvas();
  const gestureRef = useRef<PointerGesture | null>(null);
  // Touch has no hover, so tapping the handle toggles the pill instead. The
  // toggle waits for the tap's click, which would otherwise land on the pill.
  const [pillOpen, setPillOpen] = useState(false);
  const handleTappedRef = useRef(false);
  const handleRef = useRef<HTMLDivElement | null>(null);
  // The pill covers the handle, so a tap anywhere else dismisses it.
  useEffect(() => {
    if (!pillOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && handleRef.current?.contains(event.target)) return;
      setPillOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [pillOpen]);
  const container = canvas?.container ?? null;
  const obstacles = NO_PREVIEW_MINI_PLAYER_OBSTACLES;
  const sourceKey = previewMiniPlayerSourceKey(miniPlayer.source);
  const frame = canvas?.previewKey === sourceKey ? canvas.layout.frame : null;
  const { width: sourceWidth, height: sourceHeight } = sourceSize;
  const reportPreview = canvas?.reportPreview;
  const clearPreview = canvas?.clearPreview;
  useLayoutEffect(() => {
    reportPreview?.({
      key: sourceKey,
      width: miniPlayer.width,
      position: miniPlayer.position,
      lastInteraction: miniPlayer.lastInteraction,
      source: { width: sourceWidth, height: sourceHeight },
    });
  }, [
    reportPreview,
    sourceKey,
    miniPlayer.width,
    miniPlayer.position,
    miniPlayer.lastInteraction,
    sourceWidth,
    sourceHeight,
  ]);
  useLayoutEffect(() => () => clearPreview?.(sourceKey), [clearPreview, sourceKey]);

  const radius = frame ? cornerRadius(frame) : PREVIEW_MINI_PLAYER_CORNER_RADIUS;
  // Inside a wide curve the default 8px inset would land on the clipped-away corner.
  const pillInset = Math.max(8, Math.round(radius * 0.55));

  const close = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
  };

  const beginGesture = (
    event: ReactPointerEvent<HTMLElement>,
    direction: BrowserViewportResizeDirection | null,
  ) => {
    if (event.button !== 0 || !frame) return;
    gestureRef.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      pointerX: event.clientX,
      pointerY: event.clientY,
      frame,
      direction,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || !container) return;
    const delta = { x: event.clientX - gesture.pointerX, y: event.clientY - gesture.pointerY };
    if (!gesture.moved && Math.hypot(delta.x, delta.y) < HANDLE_TAP_SLOP_PX) return;
    gesture.moved = true;
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
    store.resize(threadRef, sourceKey, next.width, { x: next.x, y: next.y });
  };

  const endGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (gesture?.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    handleTappedRef.current =
      event.type === "pointerup" &&
      gesture.direction === null &&
      gesture.pointerType === "touch" &&
      !gesture.moved;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="pointer-events-none absolute inset-0">
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
            ref={handleRef}
            data-pill-open={pillOpen ? "" : undefined}
            className="group pointer-events-auto absolute z-[49] size-3 touch-none cursor-grab active:cursor-grabbing pointer-coarse:-m-2.5 pointer-coarse:size-8"
            style={{ right: pillInset, top: pillInset }}
            onPointerDown={(event) => beginGesture(event, null)}
            onPointerMove={handlePointerMove}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
            onClick={() => {
              if (!handleTappedRef.current) return;
              handleTappedRef.current = false;
              setPillOpen((open) => !open);
            }}
          >
            <div
              role={recording ? "status" : undefined}
              aria-label={recording ? "Recording preview" : undefined}
              aria-hidden={!recording}
              className="absolute right-0 top-0 size-2 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 group-data-pill-open:opacity-0 pointer-coarse:right-2.5 pointer-coarse:top-2.5"
            >
              <span
                className={cn(
                  "block size-2 rounded-full shadow-sm ring-1 ring-background/70",
                  recording
                    ? "bg-destructive motion-safe:animate-status-pulse"
                    : "bg-foreground/25",
                )}
              />
            </div>
            <div className="pointer-events-none absolute right-0 top-0 flex h-8 cursor-grab items-center gap-0.5 rounded-lg border border-border/80 bg-popover/92 p-0.5 opacity-0 shadow-lg/20 backdrop-blur-xl transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-data-pill-open:pointer-events-auto group-data-pill-open:opacity-100 active:cursor-grabbing pointer-coarse:right-2.5 pointer-coarse:top-2.5">
              {recording ? (
                <span aria-hidden className="flex size-6 shrink-0 items-center justify-center">
                  <span className="size-2 rounded-full bg-destructive motion-safe:animate-status-pulse" />
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
