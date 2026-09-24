import type { DevicePlatform, EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { refreshDeviceHubAccess, useDeviceHubAccess } from "~/state/device";
import { createCanvasFrameSink } from "@t3tools/client-runtime/device/frame";
import { resolveDeviceShape } from "@t3tools/client-runtime/device/shape-profile";
import { deviceKeyboard, deviceModel } from "./deviceModels";
import { fitDeviceFrame } from "./deviceFrameLayout";
import { DevicePhoneViewport } from "./DevicePhoneViewport";
import { DeviceLoadingView } from "./DeviceLoadingView";
import { type DeviceAxElement, fetchDeviceAxTree } from "./deviceHubApi";
import {
  createDeviceStreamClient,
  type DeviceHardwareButton,
  type DeviceScreenSize,
  type DeviceStreamClient,
  type DeviceStreamStatus,
} from "@t3tools/client-runtime/device/stream";

const AX_POLL_INTERVAL_MS = 2_000;
const CONTROLS_RAIL_WIDTH = 56;

export interface DeviceViewControls {
  readonly phone: boolean;
  readonly streaming: boolean;
  readonly phoneUnavailableReason: string | null;
  readonly showPhone: () => void;
  readonly showFlat: () => void;
  readonly resetView: () => void;
  readonly keyboard: { readonly attached: boolean; readonly toggle: () => void } | null;
}

export interface DeviceStreamHandle {
  readonly pressButton: (button: DeviceHardwareButton) => void;
  readonly rotate: () => void;
  /** False while the input socket is down; controls should disable. */
  readonly inputConnected: boolean;
}

/**
 * The live device screen. Pointer events map onto normalized coordinates in
 * the displayed frame and go to the device; keyboard input is forwarded while
 * the surface is focused. `visible=false` tears the stream down so a hidden
 * panel decodes nothing.
 */
export function DeviceStreamView(props: {
  readonly environmentId: EnvironmentId;
  readonly platform: DevicePlatform;
  readonly deviceId: string;
  readonly deviceName?: string;
  readonly deviceDescription?: string;
  readonly visible: boolean;
  readonly hostId: string;
  /** The full panel opts into the phone spike; compact viewers retain their flat presentation. */
  readonly allowPhoneView?: boolean;
  readonly renderControls?: (view: DeviceViewControls) => ReactNode;
  /** Draw accessibility element frames over the screen. */
  readonly axOverlay?: boolean;
  readonly onHandle?: (handle: DeviceStreamHandle | null) => void;
  readonly onScreen?: (screen: DeviceScreenSize | null) => void;
}) {
  const [presentation, setPresentation] = useState<"phone" | "flat">("phone");
  const [keyboardAttached, setKeyboardAttached] = useState(false);
  const [phoneUnavailable, setPhoneUnavailable] = useState(false);
  const onPhoneUnavailable = useCallback(() => setPhoneUnavailable(true), []);
  const cancelPhoneInputRef = useRef<(() => void) | null>(null);
  const cancelPhoneInput = useCallback(() => cancelPhoneInputRef.current?.(), []);
  const resetViewRef = useRef<(() => void) | null>(null);
  const resetView = useCallback(() => resetViewRef.current?.(), []);
  const onResetReady = useCallback((reset: (() => void) | null) => {
    resetViewRef.current = reset;
  }, []);
  const frameListenerRef = useRef<(() => void) | null>(null);
  const onFrameListener = useCallback((listener: (() => void) | null) => {
    frameListenerRef.current = listener;
  }, []);
  const onInputCancel = useCallback((cancel: (() => void) | null) => {
    cancelPhoneInputRef.current = cancel;
  }, []);
  const access = useDeviceHubAccess(props.environmentId, props.hostId);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const clientRef = useRef<DeviceStreamClient | null>(null);
  const [status, setStatus] = useState<DeviceStreamStatus>("connecting");
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [screen, setScreen] = useState<DeviceScreenSize | null>(null);
  const [mjpegUrl, setMjpegUrl] = useState<string | null>(null);
  const [mjpegGeneration, setMjpegGeneration] = useState(0);
  const attachMjpegImage = useCallback((image: HTMLImageElement | null) => {
    clientRef.current?.setMjpegImage(image);
  }, []);
  const [inputState, setInputState] = useState<{ connected: boolean; detail?: string }>({
    connected: false,
  });
  const { onHandle, onScreen } = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!access || !canvas || !props.visible) {
      setStatus("connecting");
      onHandle?.(null);
      return;
    }
    const client = createDeviceStreamClient(
      { platform: props.platform, deviceId: props.deviceId, access },
      createCanvasFrameSink(canvas, () => frameListenerRef.current?.()),
      {
        onStatus: (next, nextDetail) => {
          setStatus(next);
          setDetail(nextDetail);
        },
        onScreen: (next) => {
          setScreen(next);
          onScreen?.(next);
        },
        onUnauthorized: () => {
          // A fresh ticket re-runs this effect through the access dependency.
          refreshDeviceHubAccess(props.environmentId);
        },
        onMjpegFallback: (url) => {
          setMjpegUrl(url);
          setMjpegGeneration((generation) => generation + 1);
        },
        onInputConnected: (connected, detail) => {
          setInputState({ connected, ...(detail ? { detail } : {}) });
          onHandle?.({
            pressButton: client.pressButton,
            rotate: client.rotate,
            inputConnected: connected,
          });
        },
      },
    );
    clientRef.current = client;
    setMjpegUrl(null);
    setInputState({ connected: false });
    client.start();
    onHandle?.({ pressButton: client.pressButton, rotate: client.rotate, inputConnected: false });
    return () => {
      cancelPhoneInput();
      client.stop();
      clientRef.current = null;
      onHandle?.(null);
      onScreen?.(null);
      setScreen(null);
    };
  }, [
    access,
    cancelPhoneInput,
    onHandle,
    onScreen,
    props.deviceId,
    props.environmentId,
    props.platform,
    props.visible,
  ]);

  // Displayed aspect ratio (width / height) of the device as the user sees it.
  const aspect = useMemo(() => {
    if (!screen) return props.platform === "ios" ? 9 / 19.5 : 9 / 20;
    const landscape =
      screen.orientation === "landscape_left" || screen.orientation === "landscape_right";
    const w = landscape
      ? Math.max(screen.width, screen.height)
      : Math.min(screen.width, screen.height);
    const h = landscape
      ? Math.min(screen.width, screen.height)
      : Math.max(screen.width, screen.height);
    return w / h;
  }, [props.platform, screen]);

  const showPhone =
    props.allowPhoneView &&
    status === "streaming" &&
    props.visible &&
    presentation === "phone" &&
    !phoneUnavailable &&
    !mjpegUrl &&
    !props.axOverlay;
  const controlsInset = props.renderControls && !showPhone ? CONTROLS_RAIL_WIDTH : 0;

  // The frame is the largest box at `aspect` that fits the container, so a
  // narrow panel shows a shorter phone rather than a squeezed one. CSS
  // `aspect-ratio` alone cannot do this: with the height pinned to 100% the
  // width clamp wins and distorts the drawn frame.
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [host, setHost] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setHost((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const frame = useMemo(() => {
    return fitDeviceFrame(aspect, host.width, host.height, controlsInset);
  }, [aspect, controlsInset, host]);

  // serve-sim streams the raw framebuffer; rotate the display for a device
  // that reports landscape while its frames stay portrait.
  const rotation = useMemo(() => {
    if (props.platform !== "ios" || !screen || screen.width > screen.height) return 0;
    switch (screen.orientation) {
      case "landscape_left":
        return 90;
      case "landscape_right":
        return -90;
      case "portrait_upside_down":
        return 180;
      default:
        return 0;
    }
  }, [props.platform, screen]);

  // A sideways rotation draws the raw portrait frame into a landscape box:
  // the media element takes the transposed size and is rotated about the
  // box's center.
  const sideways = rotation === 90 || rotation === -90;
  const mediaStyle: React.CSSProperties = sideways
    ? {
        width: frame.height,
        height: frame.width,
        left: (frame.width - frame.height) / 2,
        top: (frame.height - frame.width) / 2,
        transform: `rotate(${rotation}deg)`,
      }
    : {
        width: frame.width,
        height: frame.height,
        ...(rotation ? { transform: `rotate(${rotation}deg)` } : {}),
      };

  // The accessibility tree is polled while the overlay is on; each poll is
  // one JSON fetch, so there is nothing to repaint between polls.
  const [axElements, setAxElements] = useState<ReadonlyArray<DeviceAxElement>>([]);
  useEffect(() => {
    if (!props.axOverlay || !access || !props.visible) return;
    const target = { access, platform: props.platform, deviceId: props.deviceId };
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const poll = async () => {
      controller = new AbortController();
      try {
        const tree = await fetchDeviceAxTree(target, controller.signal);
        if (!stopped) setAxElements(tree.elements);
      } catch {
        // Keep the last good tree; the next poll retries.
      }
      if (!stopped) timer = setTimeout(() => void poll(), AX_POLL_INTERVAL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
      setAxElements([]);
    };
  }, [access, props.axOverlay, props.deviceId, props.platform, props.visible]);

  const pointerActive = useRef(false);
  const normalizedPoint = (event: React.PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  };

  const phoneUnavailableReason = phoneUnavailable
    ? "3D is unavailable on this browser"
    : mjpegUrl
      ? "3D requires the H.264 stream"
      : props.axOverlay
        ? "Turn off accessibility frames to use 3D"
        : null;

  const keyboardSource = deviceKeyboard(props.platform, props.deviceName ?? "");
  const profile = resolveDeviceShape({
    platform: props.platform,
    name: props.deviceName ?? "",
    portraitAspect: Math.min(aspect, 1 / aspect),
  });

  return (
    <div
      className={cn(
        "relative flex size-full min-h-0 min-w-0",
        props.allowPhoneView ? "bg-background" : "bg-black/90",
      )}
    >
      {props.renderControls ? (
        <DeviceControlsSlot
          renderControls={props.renderControls}
          view={{
            phone: !!showPhone,
            streaming: status === "streaming",
            phoneUnavailableReason,
            keyboard:
              showPhone && keyboardSource
                ? {
                    attached: keyboardAttached,
                    toggle: () => {
                      cancelPhoneInput();
                      if (!keyboardAttached && screen?.orientation.startsWith("portrait"))
                        clientRef.current?.rotate();
                      setKeyboardAttached(!keyboardAttached);
                    },
                  }
                : null,
            showPhone: () => setPresentation("phone"),
            showFlat: () => setPresentation("flat"),
          }}
          onResetView={resetView}
        />
      ) : null}
      <div
        ref={hostRef}
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden outline-none",
          controlsInset && "pr-14",
        )}
        tabIndex={0}
        role="application"
        aria-label={`${props.platform === "ios" ? "iOS Simulator" : "Android Emulator"} screen`}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.metaKey && !["r", "R"].includes(event.key)) return;
          event.preventDefault();
          clientRef.current?.sendKey(event.nativeEvent, "down");
        }}
        onKeyUp={(event) => {
          if (event.target !== event.currentTarget) return;
          clientRef.current?.sendKey(event.nativeEvent, "up");
        }}
      >
        <div
          className={cn("relative select-none", showPhone && "invisible pointer-events-none")}
          style={{ width: frame.width, height: frame.height }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            (event.currentTarget.parentElement as HTMLElement | null)?.focus();
            pointerActive.current = true;
            const { x, y } = normalizedPoint(event);
            clientRef.current?.sendTouch("begin", x, y);
          }}
          onPointerMove={(event) => {
            if (!pointerActive.current) return;
            const { x, y } = normalizedPoint(event);
            clientRef.current?.sendTouch("move", x, y);
          }}
          onPointerUp={(event) => {
            if (!pointerActive.current) return;
            pointerActive.current = false;
            const { x, y } = normalizedPoint(event);
            clientRef.current?.sendTouch("end", x, y);
          }}
          onPointerCancel={(event) => {
            if (!pointerActive.current) return;
            pointerActive.current = false;
            const { x, y } = normalizedPoint(event);
            clientRef.current?.sendTouch("end", x, y);
          }}
        >
          <canvas
            ref={canvasRef}
            className={cn("absolute top-0 left-0", mjpegUrl && "hidden")}
            style={mediaStyle}
          />
          {props.visible && access && mjpegUrl ? (
            <img
              key={mjpegGeneration}
              ref={attachMjpegImage}
              alt=""
              draggable={false}
              className="absolute top-0 left-0 object-contain"
              style={mediaStyle}
            />
          ) : null}
          {axElements.length > 0 ? (
            <div className="pointer-events-none absolute inset-0" aria-hidden>
              {axElements.map((element) => (
                <div
                  key={element.id}
                  className="absolute border border-sky-400/80 bg-sky-400/10"
                  style={{
                    left: `${element.x * 100}%`,
                    top: `${element.y * 100}%`,
                    width: `${element.width * 100}%`,
                    height: `${element.height * 100}%`,
                  }}
                >
                  {element.label ? (
                    <span className="absolute -top-3.5 left-0 max-w-full truncate rounded-sm bg-sky-500 px-1 text-[9px] leading-3.5 text-white">
                      {element.label}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        {showPhone ? (
          <DevicePhoneViewport
            profile={profile}
            model={deviceModel(props.platform, props.deviceName ?? "")}
            accessory={keyboardAttached ? keyboardSource : null}
            source={canvasRef}
            onFrameListener={onFrameListener}
            client={clientRef}
            onInputCancel={onInputCancel}
            onResetReady={onResetReady}
            screen={screen}
            onUnavailable={onPhoneUnavailable}
          />
        ) : null}
        {props.allowPhoneView && !props.renderControls && status === "streaming" ? (
          <div className="absolute top-3 left-3 flex gap-1 rounded-lg border border-border/50 bg-background/90 p-1 shadow-sm">
            <Button
              variant={showPhone ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={!!showPhone}
              disabled={phoneUnavailable || !!mjpegUrl || !!props.axOverlay}
              title={
                phoneUnavailable
                  ? "3D is unavailable on this browser"
                  : mjpegUrl
                    ? "3D requires the H.264 stream"
                    : props.axOverlay
                      ? "Turn off accessibility frames to use 3D"
                      : "Show 3D phone"
              }
              onClick={() => setPresentation("phone")}
            >
              3D
            </Button>
            <Button
              variant={!showPhone ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={!showPhone}
              onClick={() => setPresentation("flat")}
            >
              Flat
            </Button>
          </div>
        ) : null}
        {status === "streaming" && !inputState.connected ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-2">
            <span className="rounded-md bg-background/85 px-2 py-1 text-xs text-muted-foreground">
              Input disconnected{inputState.detail ? ` (${inputState.detail})` : ""}, reconnecting…
            </span>
          </div>
        ) : null}
        {status !== "streaming" ? (
          <div className="absolute inset-0">
            <DeviceLoadingView
              name={props.deviceName ?? "Device"}
              description={props.deviceDescription ?? ""}
              stage="stream"
              message={status === "error" ? (detail ?? "Stream failed.") : "Connecting video…"}
              error={status === "error"}
            >
              {status === "error" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    // An expired ticket surfaces as unauthorized on restart and
                    // refreshes access through the effect; no need to mint one here.
                    clientRef.current?.stop();
                    clientRef.current?.start();
                  }}
                >
                  Reconnect
                </Button>
              ) : null}
            </DeviceLoadingView>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DeviceControlsSlot(props: {
  renderControls: (view: DeviceViewControls) => ReactNode;
  view: Omit<DeviceViewControls, "resetView">;
  onResetView: () => void;
}) {
  return props.renderControls({ ...props.view, resetView: props.onResetView });
}
