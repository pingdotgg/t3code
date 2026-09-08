import type { DevicePlatform, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { refreshDeviceHubAccess, useDeviceHubAccess } from "~/state/device";
import { Spinner } from "~/components/ui/spinner";
import {
  createDeviceStreamClient,
  type DeviceHardwareButton,
  type DeviceScreenSize,
  type DeviceStreamClient,
  type DeviceStreamStatus,
} from "./deviceStream";

export interface DeviceStreamHandle {
  readonly pressButton: (button: DeviceHardwareButton) => void;
  readonly rotate: () => void;
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
  readonly visible: boolean;
  readonly onHandle?: (handle: DeviceStreamHandle | null) => void;
  readonly onScreen?: (screen: DeviceScreenSize | null) => void;
}) {
  const access = useDeviceHubAccess(props.environmentId);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const clientRef = useRef<DeviceStreamClient | null>(null);
  const [status, setStatus] = useState<DeviceStreamStatus>("connecting");
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [screen, setScreen] = useState<DeviceScreenSize | null>(null);
  const [mjpegUrl, setMjpegUrl] = useState<string | null>(null);
  const [mjpegGeneration, setMjpegGeneration] = useState(0);
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
      canvas,
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
      },
    );
    clientRef.current = client;
    setMjpegUrl(null);
    client.start();
    onHandle?.({ pressButton: client.pressButton, rotate: client.rotate });
    return () => {
      client.stop();
      clientRef.current = null;
      onHandle?.(null);
      onScreen?.(null);
      setScreen(null);
    };
  }, [
    access,
    onHandle,
    onScreen,
    props.deviceId,
    props.environmentId,
    props.platform,
    props.visible,
  ]);

  const aspect = useMemo(() => {
    if (!screen) return props.platform === "ios" ? "9 / 19.5" : "9 / 20";
    const landscape =
      screen.orientation === "landscape_left" || screen.orientation === "landscape_right";
    const w = landscape
      ? Math.max(screen.width, screen.height)
      : Math.min(screen.width, screen.height);
    const h = landscape
      ? Math.min(screen.width, screen.height)
      : Math.max(screen.width, screen.height);
    return `${w} / ${h}`;
  }, [props.platform, screen]);

  // serve-sim streams the raw framebuffer; rotate the display for a device
  // that reports landscape while its frames stay portrait.
  const rotation = useMemo(() => {
    if (props.platform !== "ios" || !screen || screen.width > screen.height) return 0;
    switch (screen.orientation) {
      case "landscape_left":
        return -90;
      case "landscape_right":
        return 90;
      case "portrait_upside_down":
        return 180;
      default:
        return 0;
    }
  }, [props.platform, screen]);

  const pointerActive = useRef(false);
  const normalizedPoint = (event: React.PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    let x = (event.clientX - rect.left) / rect.width;
    let y = (event.clientY - rect.top) / rect.height;
    if (rotation === -90) [x, y] = [1 - y, x];
    else if (rotation === 90) [x, y] = [y, 1 - x];
    else if (rotation === 180) [x, y] = [1 - x, 1 - y];
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  };

  return (
    <div
      className="relative flex size-full items-center justify-center overflow-hidden bg-black/90 outline-none"
      tabIndex={0}
      role="application"
      aria-label={`${props.platform === "ios" ? "iOS Simulator" : "Android Emulator"} screen`}
      onKeyDown={(event) => {
        if (event.metaKey && !["r", "R"].includes(event.key)) return;
        event.preventDefault();
        clientRef.current?.sendKey(event.nativeEvent, "down");
      }}
      onKeyUp={(event) => {
        clientRef.current?.sendKey(event.nativeEvent, "up");
      }}
    >
      <div
        className="relative max-h-full max-w-full select-none"
        style={{
          aspectRatio: aspect,
          height: rotation === 0 || rotation === 180 ? "100%" : undefined,
          width: rotation === 90 || rotation === -90 ? "100%" : undefined,
        }}
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
          className={cn("size-full", mjpegUrl && "hidden")}
          style={rotation ? { transform: `rotate(${rotation}deg)` } : undefined}
        />
        {mjpegUrl ? (
          <img
            key={mjpegGeneration}
            src={mjpegUrl}
            alt=""
            draggable={false}
            className="size-full object-contain"
            style={rotation ? { transform: `rotate(${rotation}deg)` } : undefined}
          />
        ) : null}
      </div>
      {status !== "streaming" ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/70 text-sm text-muted-foreground">
          {status === "connecting" ? <Spinner /> : null}
          <span>{status === "error" ? (detail ?? "Stream failed.") : "Connecting to device…"}</span>
          {status === "connecting" && detail ? (
            <span className="max-w-xs text-center text-xs opacity-70">{detail}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
