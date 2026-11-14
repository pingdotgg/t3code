import { FILL_PREVIEW_VIEWPORT, type ScopedThreadRef } from "@t3tools/contracts";
import { previewPdfAssetUrl } from "@t3tools/shared/preview";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { PanelRightIcon, PictureInPicture2, XIcon } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { create } from "zustand";
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import { useChatCanvas } from "../chat/ChatCanvasContext";
import type { ChatCanvasPreview } from "../chat/chatCanvasLayout";
import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import {
  findActiveBrowserRecordingRuntimeTabId,
  useActiveBrowserRecordingTabIds,
} from "~/browser/browserRecording";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import type { BrowserViewportResizeDirection } from "~/browser/browserViewportLayout";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { rendersServerTabNatively } from "~/browser/previewRuntime";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { type ServerBrowserHandle, ServerBrowserSurface } from "~/browser/ServerBrowserSurface";
import {
  closeServerPictureInPicture,
  openServerPictureInPicture,
  serverPictureInPictureKey,
  supportsServerPictureInPicture,
  useServerPictureInPictureKey,
} from "~/browser/serverPictureInPicture";
import { useBrowserLayoutZoomFactor } from "~/browser/useBrowserLayoutZoomFactor";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useThreadPreviewState } from "~/previewStateStore";
import {
  type PreviewMiniPlayerSize,
  type PreviewMiniPlayerSource,
  type PreviewMiniPlayerState,
  browserMiniPlayerSource,
  previewMiniPlayerSourceKey,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { useDeviceState } from "~/state/device";

import { DeviceStreamView } from "../device/DeviceStreamView";
import type { DeviceScreenSize } from "@t3tools/client-runtime/device/stream";
import { Atom } from "effect/reactivity";
import { deviceScreenKey, deviceStreamScreenAtom } from "../device/deviceStreamSession";
import type { PreviewStreamViewport } from "@t3tools/client-runtime/preview/server-browser-stream";
import { previewBridge } from "./previewBridge";
import { PreviewUnreachable } from "./PreviewUnreachable";
import { showPreviewPopup } from "./showPreviewPopup";
import {
  type PreviewMiniPlayerGesture,
  settlePreviewMiniPlayerResize,
  stepPreviewMiniPlayerGesture,
} from "./previewMiniPlayerGesture";
import {
  PREVIEW_MINI_PLAYER_CORNER_RADIUS,
  PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX,
  type PreviewMiniPlayerFrame,
  resolveDeviceMiniPlayerCornerRadius,
  resolveDeviceMiniPlayerSourceSize,
  resolvePreviewMiniPlayerSourceSize,
} from "./previewMiniPlayerLayout";

interface Props {
  readonly threadRef: ScopedThreadRef;
  readonly miniPlayer: PreviewMiniPlayerState;
}

const frameCornerRadius = () => PREVIEW_MINI_PLAYER_CORNER_RADIUS;

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

// What the stream reports about its source. It lives outside the player so the
// chat canvas lays out the frame from the same source size the player uses. One
// slot is enough, since only the shown thread renders a player, and it keeps the
// store from collecting an entry for every tab a session ever streamed.
const useStreamedSourceSize = create<{
  readonly key: string;
  readonly viewport: PreviewStreamViewport;
} | null>(() => null);

// The source size a resize in progress lays the frame out from, so a source that changes shape
// under a held handle cannot resize the player by itself. Same single slot as above.
const useHeldSourceSize = create<{
  readonly key: string;
  readonly source: PreviewMiniPlayerSize;
} | null>(() => null);

const NO_DEVICE_SCREEN_ATOM = Atom.make<DeviceScreenSize | null>(null).pipe(
  Atom.withLabel("device-stream-screen:none"),
);

const streamedSourceKey = (threadRef: ScopedThreadRef, sourceKey: string) =>
  `${scopedThreadKey(threadRef)}\u0000${sourceKey}`;

// The mini player's device stream view, named so the canvas can read the
// screen size that view reports.
const miniPlayerDeviceViewId = (
  threadRef: ScopedThreadRef,
  source: Extract<PreviewMiniPlayerSource, { kind: "device" }>,
) =>
  `preview-mini-player\u0000${scopedThreadKey(threadRef)}\u0000${deviceScreenKey(threadRef.environmentId, source.hostId, source.deviceId)}`;

function useBrowserMiniPlayerSource(threadRef: ScopedThreadRef | null, tabId: string | null) {
  const previewState = useThreadPreviewState(threadRef);
  const snapshot = tabId === null ? null : (previewState.sessions[tabId] ?? null);
  const runtimeTabId =
    threadRef && tabId !== null
      ? previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId)
      : null;
  const desktopOverlay = tabId === null ? null : (previewState.desktopByTabId[tabId] ?? null);
  const layoutZoomFactor = useBrowserLayoutZoomFactor(desktopOverlay?.zoomFactor ?? 1);
  const fittedSourceContent = useBrowserSurfaceStore((state) =>
    runtimeTabId === null ? null : (state.byTabId[runtimeTabId]?.fittedSourceContent ?? null),
  );
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const serverTab =
    threadRef !== null &&
    snapshot?.runtime === "server" &&
    !rendersServerTabNatively(threadRef.environmentId, primaryEnvironmentId, snapshot);
  const streamViewport = useStreamedSourceSize((state) =>
    threadRef &&
    tabId !== null &&
    state?.key ===
      streamedSourceKey(threadRef, previewMiniPlayerSourceKey(browserMiniPlayerSource(tabId)))
      ? state.viewport
      : null,
  );
  const sourceSize: PreviewMiniPlayerSize =
    serverTab && streamViewport
      ? streamViewport
      : resolvePreviewMiniPlayerSourceSize(
          snapshot?.viewport ?? FILL_PREVIEW_VIEWPORT,
          fittedSourceContent,
          layoutZoomFactor,
        );
  return { serverEpoch: previewState.serverEpoch, snapshot, desktopOverlay, serverTab, sourceSize };
}

/** The mini player as the chat canvas lays it out; null when no player renders. */
export function useThreadPreviewCanvasSource(
  threadRef: ScopedThreadRef | null,
  miniPlayer: PreviewMiniPlayerState | null,
): ChatCanvasPreview | null {
  const source = miniPlayer?.source ?? null;
  const browser = useBrowserMiniPlayerSource(
    threadRef,
    source?.kind === "browser" ? source.tabId : null,
  );
  const sourceKey = source ? previewMiniPlayerSourceKey(source) : null;
  const screen = useAtomValue(
    threadRef && source?.kind === "device"
      ? deviceStreamScreenAtom(miniPlayerDeviceViewId(threadRef, source))
      : NO_DEVICE_SCREEN_ATOM,
  );
  const heldSource = useHeldSourceSize((state) =>
    threadRef && sourceKey !== null && state?.key === streamedSourceKey(threadRef, sourceKey)
      ? state.source
      : null,
  );
  if (!miniPlayer || !source || sourceKey === null) return null;
  if (source.kind === "browser" && !browser.snapshot) return null;
  return {
    key: sourceKey,
    width: miniPlayer.width,
    position: miniPlayer.position,
    lastInteraction: miniPlayer.lastInteraction,
    source:
      heldSource ??
      (source.kind === "browser"
        ? browser.sourceSize
        : resolveDeviceMiniPlayerSourceSize(source.platform, screen)),
  };
}

export function ThreadPreviewMiniPlayer({ threadRef, miniPlayer }: Props) {
  const { source } = miniPlayer;
  return source.kind === "browser" ? (
    <BrowserMiniPlayer
      key={source.tabId}
      threadRef={threadRef}
      tabId={source.tabId}
      miniPlayer={miniPlayer}
    />
  ) : (
    <DeviceMiniPlayer
      key={previewMiniPlayerSourceKey(source)}
      threadRef={threadRef}
      source={source}
      miniPlayer={miniPlayer}
    />
  );
}

function BrowserMiniPlayer({ threadRef, tabId, miniPlayer }: Props & { readonly tabId: string }) {
  const httpBaseUrl = useEnvironmentHttpBaseUrl(threadRef.environmentId);
  const { serverEpoch, snapshot, desktopOverlay, serverTab, sourceSize } =
    useBrowserMiniPlayerSource(threadRef, tabId);
  const runtimeTabId = previewRuntimeTabId(threadRef, serverEpoch, tabId);
  const recordingTabIds = useActiveBrowserRecordingTabIds();
  const recording =
    recordingTabIds.has(runtimeTabId) ||
    findActiveBrowserRecordingRuntimeTabId(threadRef, tabId) !== null;
  const serverSurfaceRef = useRef<ServerBrowserHandle | null>(null);
  const serverPictureInPicture =
    useServerPictureInPictureKey() === serverPictureInPictureKey(threadRef.threadId, tabId);
  const viewportKey = streamedSourceKey(
    threadRef,
    previewMiniPlayerSourceKey(browserMiniPlayerSource(tabId)),
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
  const pdfUrl =
    snapshot.navStatus._tag === "Success"
      ? previewPdfAssetUrl(snapshot.navStatus.url, httpBaseUrl)
      : null;
  const loadFailed = snapshot.navStatus._tag === "LoadFailed" ? snapshot.navStatus : null;
  const poppedOut = serverTab ? serverPictureInPicture : Boolean(desktopOverlay?.pictureInPicture);
  const canPopOut = serverTab
    ? poppedOut || (pdfUrl === null && supportsServerPictureInPicture())
    : true;

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
              pdfUrl={pdfUrl}
              visible
              followSize={false}
              controlPosition="bottom"
              onViewport={(viewport) =>
                useStreamedSourceSize.setState(
                  (state) =>
                    state?.key === viewportKey &&
                    state.viewport.width === viewport.width &&
                    state.viewport.height === viewport.height
                      ? state
                      : { key: viewportKey, viewport },
                  true,
                )
              }
              onPopup={(popupTabId) => showPreviewPopup(threadRef, popupTabId, "floating")}
              className="size-full"
            />
          </div>
        ) : (
          <>
            <BrowserSurfaceSlot
              tabId={runtimeTabId}
              visible={Boolean(desktopOverlay?.hasWebContents) && !loadFailed}
              cornerRadius={PREVIEW_MINI_PLAYER_CORNER_RADIUS}
              zIndex={PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX}
              fitSourceContent
              layoutVersion={`${frame.x}:${frame.y}`}
              className="absolute inset-0"
            />
            {loadFailed ? (
              <div className="pointer-events-auto absolute inset-0 z-[48] overflow-hidden rounded-[inherit]">
                <PreviewUnreachable
                  url={loadFailed.url}
                  code={loadFailed.code}
                  description={loadFailed.description}
                  onReload={() => void previewBridge?.refresh(runtimeTabId)}
                />
              </div>
            ) : !desktopOverlay?.hasWebContents ? (
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
  const viewId = miniPlayerDeviceViewId(threadRef, source);
  const screen = useAtomValue(deviceStreamScreenAtom(viewId));
  const sourceSize = resolveDeviceMiniPlayerSourceSize(source.platform, screen);
  const device = deviceState.devices.find(
    (entry) => entry.hostId === source.hostId && entry.id === source.deviceId,
  );
  const host = deviceState.hosts.find((entry) => entry.id === source.hostId);
  const hostLabel = host?.label ?? "Device host";
  const cornerRadius = (player: PreviewMiniPlayerSize) =>
    resolveDeviceMiniPlayerCornerRadius(source.platform, player);

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
            viewId={viewId}
            serveSimOnly={host?.kind === "simlock"}
          />
        </div>
      )}
    </MiniPlayerShell>
  );
}

/** Match native clipping and DOM radii to align their separately composited edges. */
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
  readonly onOpenInPanel: () => void;
  readonly pillActions?: ReactNode;
  readonly recording?: boolean;
  readonly cornerRadius?: (frame: PreviewMiniPlayerSize) => number;
  readonly children: (frame: PreviewMiniPlayerFrame) => ReactNode;
}) {
  const canvas = useChatCanvas();
  const gestureRef = useRef<PreviewMiniPlayerGesture | null>(null);
  const captureRef = useRef<HTMLElement | null>(null);
  // Touch toggles the pill after the tap's click so that click cannot land on the newly opened pill.
  const [pillOpen, setPillOpen] = useState(false);
  const handleTappedRef = useRef(false);
  const handleRef = useRef<HTMLDivElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- document pointerdown listener closes the open pill on an outside press
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
  const sourceKey = previewMiniPlayerSourceKey(miniPlayer.source);
  const heldSourceKey = streamedSourceKey(threadRef, sourceKey);
  const frame = canvas?.previewKey === sourceKey ? canvas.layout.frame : null;

  const radius = frame ? cornerRadius(frame) : PREVIEW_MINI_PLAYER_CORNER_RADIUS;
  const pillInset = Math.max(8, Math.round(radius * 0.55));

  const close = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
  };

  /** Every way a gesture stops comes through here; returns the gesture it ended. */
  const finishGesture = () => {
    const gesture = gestureRef.current;
    if (!gesture) return null;
    gestureRef.current = null;
    handleTappedRef.current = false;
    const handle = captureRef.current;
    captureRef.current = null;
    if (handle?.hasPointerCapture(gesture.pointerId)) {
      handle.releasePointerCapture(gesture.pointerId);
    }
    if (gesture.direction === null) return gesture;
    useHeldSourceSize.setState((state) => (state?.key === heldSourceKey ? null : state), true);
    const settled =
      frame && container
        ? settlePreviewMiniPlayerResize({
            frame,
            direction: gesture.direction,
            held: gesture.source,
            source: sourceSize,
            container,
          })
        : null;
    if (settled) {
      usePreviewMiniPlayerStore
        .getState()
        .resize(threadRef, sourceKey, settled.width, { x: settled.x, y: settled.y });
    }
    return gesture;
  };
  const endInterruptedGesture = useEffectEvent(() => {
    finishGesture();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window blur ends a gesture whose release went to another window, and unmount ends one in progress
  useEffect(() => {
    window.addEventListener("blur", endInterruptedGesture);
    return () => {
      window.removeEventListener("blur", endInterruptedGesture);
      useHeldSourceSize.setState((state) => (state?.key === heldSourceKey ? null : state), true);
    };
  }, [heldSourceKey]);

  const beginGesture = (
    event: ReactPointerEvent<HTMLElement>,
    direction: BrowserViewportResizeDirection | null,
  ) => {
    if (event.button !== 0 || !frame) return;
    finishGesture();
    gestureRef.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      pointerX: event.clientX,
      pointerY: event.clientY,
      frame,
      direction,
      source: sourceSize,
      moved: false,
    };
    captureRef.current = event.currentTarget;
    if (direction !== null) {
      useHeldSourceSize.setState({ key: heldSourceKey, source: sourceSize }, true);
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || !container) return;
    const step = stepPreviewMiniPlayerGesture(gesture, event, container);
    if (step.kind === "ignore") return;
    if (step.kind === "end") {
      finishGesture();
      return;
    }
    if (!gesture.moved) gestureRef.current = { ...gesture, moved: true };
    const store = usePreviewMiniPlayerStore.getState();
    if (step.kind === "move") {
      store.move(threadRef, sourceKey, step.position);
      return;
    }
    store.resize(threadRef, sourceKey, step.frame.width, { x: step.frame.x, y: step.frame.y });
  };

  const endGesture = (event: ReactPointerEvent<HTMLElement>) => {
    if (gestureRef.current?.pointerId !== event.pointerId) return;
    const gesture = finishGesture();
    handleTappedRef.current =
      event.type === "pointerup" &&
      gesture?.direction === null &&
      gesture.pointerType === "touch" &&
      !gesture.moved;
  };

  // Capture can go without a release or cancel: the handle is replaced, or the platform takes it.
  const handleLostCapture = (event: ReactPointerEvent<HTMLElement>) => {
    if (
      gestureRef.current?.pointerId === event.pointerId &&
      captureRef.current === event.currentTarget
    ) {
      finishGesture();
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
            onLostPointerCapture={handleLostCapture}
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
              onLostPointerCapture={handleLostCapture}
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}
