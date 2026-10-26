import type { DevicePlatform, EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useId, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { renewDeviceHubAccess, useDeviceHubAccess } from "~/state/device";
import { resolveDeviceShape } from "@t3tools/client-runtime/device/shape-profile";
import { deviceKeyboard, deviceModel } from "./deviceModels";
import { fitDeviceFrame } from "./deviceFrameLayout";
import { DeviceDuoViewport } from "./DeviceDuoViewport";
import { DeviceDuoControls } from "./DeviceDuoControls";
import { DeviceAndroidFoldControls } from "./DeviceAndroidFoldControls";
import { DevicePhoneViewport } from "./DevicePhoneViewport";
import { DeviceLoadingView } from "./DeviceLoadingView";
import type { DeviceAxElement } from "./deviceHubApi";
import { androidFoldViewAtom, deviceAxElementsAtom } from "./deviceHubAtoms";
import {
  deviceScreenKey,
  deviceStreamSessionAtom,
  type DeviceStreamSession,
  IDLE_DEVICE_STREAM_STATE,
} from "./deviceStreamSession";
import type { DeviceHardwareButton, DeviceScreenSize } from "@t3tools/client-runtime/device/stream";
import { observeResize } from "~/lib/observeResize";

const NO_SESSION_ATOM = Atom.make<DeviceStreamSession | null>(null).pipe(
  Atom.withLabel("device-stream:none"),
);
const NO_AX_ELEMENTS: ReadonlyArray<DeviceAxElement> = [];
const NO_AX_ATOM = Atom.make(AsyncResult.initial<ReadonlyArray<DeviceAxElement>, never>()).pipe(
  Atom.withLabel("device-ax-elements:none"),
);
const CONTROLS_RAIL_WIDTH = 56;

function screenAspect(platform: DevicePlatform, screen: DeviceScreenSize | null): number {
  if (!screen) return platform === "ios" ? 9 / 19.5 : 9 / 20;
  const landscape =
    screen.orientation === "landscape_left" || screen.orientation === "landscape_right";
  const w = landscape
    ? Math.max(screen.width, screen.height)
    : Math.min(screen.width, screen.height);
  const h = landscape
    ? Math.min(screen.width, screen.height)
    : Math.max(screen.width, screen.height);
  return w / h;
}

// serve-sim sends raw portrait framebuffers even when iOS reports landscape; rotate the display.
function screenRotation(platform: DevicePlatform, screen: DeviceScreenSize | null): number {
  if (platform !== "ios" || !screen || screen.width > screen.height) return 0;
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
}

export interface DeviceViewControls {
  readonly phone: boolean;
  readonly streaming: boolean;
  readonly phoneUnavailableReason: string | null;
  readonly showPhone: () => void;
  readonly showFlat: () => void;
  readonly resetView: () => void;
  readonly foldingControls?: ReactNode;
  readonly keyboard: { readonly attached: boolean; readonly toggle: () => void } | null;
  readonly handle: DeviceStreamHandle | null;
}

export interface DeviceStreamHandle {
  readonly pressButton: (button: DeviceHardwareButton) => void;
  readonly rotate: () => void;
  readonly inputConnected: boolean;
}

export function DeviceStreamView(props: {
  readonly environmentId: EnvironmentId;
  readonly platform: DevicePlatform;
  readonly deviceId: string;
  readonly deviceName?: string;
  readonly deviceDescription?: string;
  readonly visible: boolean;
  readonly hostId: string;
  readonly allowPhoneView?: boolean;
  readonly renderControls?: (view: DeviceViewControls) => ReactNode;
  readonly axOverlay?: boolean;
  /** Lets a parent read this view's own stream state, such as its screen size. */
  readonly viewId?: string;
}) {
  const model = deviceModel(props.platform, props.deviceName ?? "");
  const isDuo = model?.id === "iphone-duo";
  const [presentation, setPresentation] = useState<"phone" | "flat">("phone");
  const [keyboardAttached, setKeyboardAttached] = useState(false);
  const cancelPhoneInputRef = useRef<(() => void) | null>(null);
  const cancelPhoneInput = () => cancelPhoneInputRef.current?.();
  const resetViewRef = useRef<(() => void) | null>(null);
  const onResetReady = (reset: (() => void) | null) => {
    resetViewRef.current = reset;
  };
  const onInputCancel = (cancel: (() => void) | null) => {
    cancelPhoneInputRef.current = cancel;
  };
  const access = useDeviceHubAccess(props.environmentId, props.hostId);
  const ownViewId = useId();
  const viewId = props.viewId ?? ownViewId;
  const session = useAtomValue(
    access && props.visible
      ? deviceStreamSessionAtom({
          environmentId: props.environmentId,
          hostId: props.hostId,
          platform: props.platform,
          deviceId: props.deviceId,
          access,
          viewId,
        })
      : NO_SESSION_ATOM,
  );
  const client = session?.stream ?? null;
  const canvas = session?.canvas ?? null;
  const { status, detail, hasFrame, screen, mjpegUrl, mjpegGeneration, duoControl } =
    session?.state ?? IDLE_DEVICE_STREAM_STATE;
  const inputState = session?.state.input ?? IDLE_DEVICE_STREAM_STATE.input;
  const phoneUnavailable = session?.state.phoneUnavailable ?? false;
  const foldAngle = useAtomValue(
    androidFoldViewAtom(deviceScreenKey(props.environmentId, props.hostId, props.deviceId)),
  ).angle;
  const attachMjpegImage = (image: HTMLImageElement | null) => {
    if (!client || !image) return;
    client.setMjpegImage(image);
    return () => client.setMjpegImage(null);
  };
  const mountCanvas = (node: HTMLDivElement | null) => {
    if (!node || !canvas) return;
    node.append(canvas);
    return () => canvas.remove();
  };

  const aspect = screenAspect(props.platform, screen);

  const retainingFrame =
    status === "connecting" && hasFrame && inputState.connected && screen !== null;
  const showPhone =
    props.allowPhoneView &&
    (status === "streaming" || retainingFrame) &&
    props.visible &&
    presentation === "phone" &&
    !phoneUnavailable &&
    !mjpegUrl &&
    !props.axOverlay &&
    (!isDuo || screen?.supportsHingeAngle === true);
  const controlsInset = props.renderControls && !showPhone ? CONTROLS_RAIL_WIDTH : 0;

  // Fit the frame in both dimensions; pinned CSS height plus a width clamp distorts aspect-ratio.
  const [host, setHost] = useState({ width: 0, height: 0 });
  const hostRef = (element: HTMLDivElement | null) => {
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
    return observeResize(element, update);
  };
  const frame = fitDeviceFrame(aspect, host.width, host.height, controlsInset);

  const rotation = screenRotation(props.platform, screen);

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

  const axResult = useAtomValue(
    props.axOverlay && access && props.visible
      ? deviceAxElementsAtom({ access, platform: props.platform, deviceId: props.deviceId })
      : NO_AX_ATOM,
  );
  const axElements = Option.getOrElse(AsyncResult.value(axResult), () => NO_AX_ELEMENTS);

  const pointerActive = useRef(false);
  const normalizedPoint = (event: React.PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  };

  const phoneUnavailableReason =
    isDuo && !screen?.supportsHingeAngle
      ? "iPhone Duo 3D requires Device Hub 0.11.0 or newer"
      : phoneUnavailable
        ? "3D is unavailable on this browser"
        : mjpegUrl
          ? "3D requires the H.264 stream"
          : props.axOverlay
            ? "Turn off accessibility frames to use 3D"
            : null;

  const keyboardSource = deviceKeyboard(props.platform, props.deviceName ?? "");
  const resetView = () => {
    if (!isDuo) {
      const orientation = keyboardAttached ? "landscape_right" : "portrait";
      if (screen?.orientation !== orientation) client?.setOrientation(orientation);
    }
    resetViewRef.current?.();
  };
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
            foldingControls:
              props.platform === "android" && access ? (
                <DeviceAndroidFoldControls
                  key={`${props.hostId}:${props.deviceId}`}
                  access={access}
                  deviceId={props.deviceId}
                  visible={props.visible}
                  enabled={status === "streaming"}
                  screenWidth={screen?.width}
                  screenHeight={screen?.height}
                  deviceKey={deviceScreenKey(props.environmentId, props.hostId, props.deviceId)}
                  renewAccess={() => renewDeviceHubAccess(props.environmentId, props.hostId)}
                />
              ) : showPhone && isDuo && screen?.supportsHingeAngle ? (
                <DeviceDuoControls
                  screen={screen}
                  state={duoControl}
                  enabled={inputState.connected}
                  onCommand={(command) => {
                    cancelPhoneInput();
                    client?.controlDuo(command);
                  }}
                />
              ) : null,
            keyboard:
              showPhone && keyboardSource
                ? {
                    attached: keyboardAttached,
                    toggle: () => {
                      cancelPhoneInput();
                      if (!keyboardAttached && screen?.orientation !== "landscape_right")
                        client?.setOrientation("landscape_right");
                      setKeyboardAttached(!keyboardAttached);
                    },
                  }
                : null,
            showPhone: () => setPresentation("phone"),
            showFlat: () => setPresentation("flat"),
            handle: client
              ? {
                  pressButton: client.pressButton,
                  rotate: client.rotate,
                  inputConnected: inputState.connected,
                }
              : null,
          }}
          onResetView={resetView}
        />
      ) : null}
      <div
        ref={hostRef}
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden outline-none",
          // Overlay the stream; focus (including pointer-driven focus) marks keyboard capture.
          "after:pointer-events-none after:absolute after:inset-0 after:z-10 focus:after:ring-2 focus:after:ring-inset focus:after:ring-ring",
          controlsInset && "pr-14",
        )}
        tabIndex={0}
        role="application"
        aria-label={`${props.platform === "ios" ? "iOS Simulator" : "Android Emulator"} screen`}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.metaKey && !["r", "R"].includes(event.key)) return;
          // Let browser paste chords fire the paste event.
          if (
            (event.ctrlKey && (event.key === "v" || event.key === "V")) ||
            (event.shiftKey && event.key === "Insert")
          ) {
            return;
          }
          event.preventDefault();
          client?.sendKey(event.nativeEvent, "down");
        }}
        onPaste={(event) => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          client?.sendText(event.clipboardData.getData("text/plain"));
        }}
        onKeyUp={(event) => {
          if (event.target !== event.currentTarget) return;
          client?.sendKey(event.nativeEvent, "up");
        }}
      >
        <div
          className={cn("relative select-none", showPhone && "invisible pointer-events-none")}
          style={{ width: frame.width, height: frame.height }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            (event.currentTarget.parentElement as HTMLElement | null)?.focus();
            pointerActive.current = true;
            const { x, y } = normalizedPoint(event);
            client?.sendTouch("begin", x, y);
          }}
          onPointerMove={(event) => {
            if (!pointerActive.current) return;
            const { x, y } = normalizedPoint(event);
            client?.sendTouch("move", x, y);
          }}
          onPointerUp={(event) => {
            if (!pointerActive.current) return;
            pointerActive.current = false;
            const { x, y } = normalizedPoint(event);
            client?.sendTouch("end", x, y);
          }}
          onPointerCancel={(event) => {
            if (!pointerActive.current) return;
            pointerActive.current = false;
            const { x, y } = normalizedPoint(event);
            client?.sendTouch("end", x, y);
          }}
        >
          <div
            ref={mountCanvas}
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
                  className="absolute border border-info/80 bg-info/10"
                  style={{
                    left: `${element.x * 100}%`,
                    top: `${element.y * 100}%`,
                    width: `${element.width * 100}%`,
                    height: `${element.height * 100}%`,
                  }}
                >
                  {element.label ? (
                    <span className="absolute -top-3.5 left-0 max-w-full truncate rounded-sm bg-info px-1 text-3xs leading-3.5 text-white">
                      {element.label}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        {session && showPhone && isDuo && model ? (
          <DeviceDuoViewport
            onFrameListener={session.setFrameListener}
            onControlRejectedListener={session.setControlRejectedListener}
            model={model}
            hingePreview={
              duoControl.requested?.control === "angle" ? duoControl.requested.value : null
            }
            source={session.canvas}
            client={session.stream}
            onInputCancel={onInputCancel}
            onResetReady={onResetReady}
            screen={screen}
            onUnavailable={session.markPhoneUnavailable}
          />
        ) : session && showPhone ? (
          <DevicePhoneViewport
            profile={profile}
            model={deviceModel(props.platform, props.deviceName ?? "")}
            accessory={keyboardAttached ? keyboardSource : null}
            source={session.canvas}
            onFrameListener={session.setFrameListener}
            client={session.stream}
            onInputCancel={onInputCancel}
            onResetReady={onResetReady}
            screen={screen}
            foldAngle={foldAngle}
            onUnavailable={session.markPhoneUnavailable}
          />
        ) : null}
        {props.allowPhoneView && !props.renderControls && status === "streaming" ? (
          <div className="absolute top-3 left-3 flex gap-1 rounded-lg border border-border/50 bg-background/90 p-1 shadow-sm">
            <Button
              variant={showPhone ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={!!showPhone}
              disabled={!!phoneUnavailableReason}
              title={phoneUnavailableReason ?? "Show 3D phone"}
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
        {retainingFrame && showPhone ? (
          // Shown only once the device has been silent for two seconds.
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-2 transition-opacity delay-2000 duration-0 starting:opacity-0">
            <span className="rounded-md bg-background/85 px-2 py-1 text-xs text-muted-foreground">
              Waiting for device video…
            </span>
          </div>
        ) : null}
        {status !== "streaming" && !(retainingFrame && showPhone) ? (
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
                    // refreshes access, which starts a new session.
                    session?.reconnect();
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
