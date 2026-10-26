import { useEffect, useRef } from "react";
import type { PhoneViewer } from "@t3tools/client-runtime/device/phone-viewer";
import type {
  DeviceAccessorySource,
  DeviceModelSource,
} from "@t3tools/client-runtime/device/model";
import type { DeviceShapeProfile } from "@t3tools/client-runtime/device/shape-profile";
import type { createPhoneInteraction } from "@t3tools/client-runtime/device/phone-interaction";
import type { DeviceScreenSize, DeviceStreamClient } from "@t3tools/client-runtime/device/stream";
import { mountDeviceViewer } from "./mountDeviceViewer";

const loadPhoneViewer = () => import("@t3tools/client-runtime/device/phone-viewer");

export function DevicePhoneViewport(props: {
  readonly profile: DeviceShapeProfile;
  readonly model: DeviceModelSource | null;
  readonly accessory: DeviceAccessorySource | null;
  readonly source: HTMLCanvasElement;
  readonly onFrameListener: (listener: (() => void) | null) => void;
  readonly onResetReady: (reset: (() => void) | null) => void;
  readonly onInputCancel: (cancel: (() => void) | null) => void;
  readonly client: DeviceStreamClient;
  readonly screen: DeviceScreenSize | null;
  readonly foldAngle: number | null;
  readonly onUnavailable: () => void;
}) {
  const viewerRef = useRef<PhoneViewer | null>(null);
  const interactionRef = useRef<ReturnType<typeof createPhoneInteraction> | null>(null);
  const screenRef = useRef(props.screen);
  const foldAngleRef = useRef(props.foldAngle);
  const profileRef = useRef(props.profile);
  const modelRef = useRef(props.model);
  const accessoryRef = useRef(props.accessory);
  const { source, onFrameListener, client, onInputCancel, onResetReady, onUnavailable } = props;

  useEffect(() => {
    foldAngleRef.current = props.foldAngle;
    viewerRef.current?.setFoldAngle(props.foldAngle);
  }, [props.foldAngle]);

  useEffect(() => {
    screenRef.current = props.screen;
    profileRef.current = props.profile;
    modelRef.current = props.model;
    accessoryRef.current = props.accessory;
    interactionRef.current?.end();
    viewerRef.current?.setModel(props.model);
    viewerRef.current?.setAccessory(props.accessory);
    viewerRef.current?.setScreen(props.screen, props.profile);
  }, [props.screen, props.profile, props.model, props.accessory]);

  // The 3D viewer lives as long as its canvas; later prop changes are pushed into it above.
  const mountViewer = (canvas: HTMLCanvasElement | null) => {
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    return mountDeviceViewer(canvas, host, {
      load: () =>
        loadPhoneViewer().then(
          ({ createPhoneViewer }) =>
            () =>
              createPhoneViewer({
                canvas,
                source,
                onUnavailable,
                onModelError: (cause) => console.warn("Device 3D asset could not load", cause),
                profile: profileRef.current,
                model: modelRef.current,
                accessory: accessoryRef.current,
                foldAngle: foldAngleRef.current,
              }),
        ),
      touch: (phase, point) => client.sendTouch(phase, point.x, point.y),
      viewerRef,
      interactionRef,
      onInputCancel,
      onResetReady,
      onFrameListener,
      onUnavailable,
      ready: ({ viewer }) => {
        viewer.setScreen(screenRef.current);
        return { frame: viewer.frameUpdated };
      },
    });
  };

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  };
  return (
    <div className="absolute inset-0">
      <div className="absolute inset-0">
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-[6%] left-1/2 h-5 w-2/5 -translate-x-1/2 rounded-full bg-foreground/10 blur-xl"
        />
        <canvas
          ref={mountViewer}
          aria-label="Interactive 3D device. Drag the screen to interact. Drag outside it or swipe with two fingers to turn."
          className="size-full touch-none"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            if (!interactionRef.current?.begin(event.pointerId, point(event), event.altKey)) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            (event.currentTarget.closest('[role="application"]') as HTMLElement | null)?.focus();
          }}
          onPointerMove={(event) => interactionRef.current?.move(event.pointerId, point(event))}
          onPointerUp={(event) => {
            interactionRef.current?.move(event.pointerId, point(event));
            interactionRef.current?.end(event.pointerId);
          }}
          onPointerCancel={(event) => interactionRef.current?.end(event.pointerId)}
          onLostPointerCapture={(event) => interactionRef.current?.end(event.pointerId)}
        />
      </div>
    </div>
  );
}
