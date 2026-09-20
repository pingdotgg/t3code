import { useEffect, useRef, type RefObject } from "react";
import type { PhoneViewer } from "@t3tools/client-runtime/device/phone-viewer";
import type {
  DeviceAccessorySource,
  DeviceModelSource,
} from "@t3tools/client-runtime/device/model";
import type { DeviceShapeProfile } from "@t3tools/client-runtime/device/shape-profile";
import { createPhoneInteraction } from "@t3tools/client-runtime/device/phone-interaction";
import type { DeviceScreenSize, DeviceStreamClient } from "@t3tools/client-runtime/device/stream";
import { bindPhoneTrackpad } from "./phoneTrackpad";

const loadPhoneViewer = () => import("@t3tools/client-runtime/device/phone-viewer");

/** Web shell for the framework-independent viewer. The decoded screen and input connection remain owned by DeviceStreamView. */
export function DevicePhoneViewport(props: {
  readonly contentOffset: number;
  readonly profile: DeviceShapeProfile;
  readonly model: DeviceModelSource | null;
  readonly accessory: DeviceAccessorySource | null;
  readonly source: RefObject<HTMLCanvasElement | null>;
  readonly onFrameListener: (listener: (() => void) | null) => void;
  readonly onResetReady: (reset: (() => void) | null) => void;
  readonly onInputCancel: (cancel: (() => void) | null) => void;
  readonly client: RefObject<DeviceStreamClient | null>;
  readonly screen: DeviceScreenSize | null;
  readonly onUnavailable: () => void;
  readonly onFramingAspect: (aspect: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<PhoneViewer | null>(null);
  const interactionRef = useRef<ReturnType<typeof createPhoneInteraction> | null>(null);
  const screenRef = useRef(props.screen);
  const profileRef = useRef(props.profile);
  const modelRef = useRef(props.model);
  const accessoryRef = useRef(props.accessory);
  const {
    source,
    onFrameListener,
    client,
    onInputCancel,
    onResetReady,
    onUnavailable,
    onFramingAspect,
  } = props;

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

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const decoded = source.current;
    if (!host || !canvas || !decoded) return;
    let disposed = false;
    let trackpad: ReturnType<typeof bindPhoneTrackpad> | null = null;
    const resize = () => {
      const { width, height } = host.getBoundingClientRect();
      viewerRef.current?.resize(width, height, window.devicePixelRatio);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const blur = () => {
      interactionRef.current?.end();
      trackpad?.cancel();
    };
    onInputCancel(blur);
    window.addEventListener("blur", blur);
    void loadPhoneViewer()
      .then(({ createPhoneViewer }) => {
        if (disposed) return;
        const viewer = createPhoneViewer({
          canvas,
          source: decoded,
          onUnavailable,
          onFramingAspect,
          onModelError: (cause) => console.warn("Device 3D asset could not load", cause),
          profile: profileRef.current,
          model: modelRef.current,
          accessory: accessoryRef.current,
        });
        viewerRef.current = viewer;
        onResetReady(viewer.resetPose);
        viewer.setScreen(screenRef.current);
        onFrameListener(viewer.frameUpdated);
        interactionRef.current = createPhoneInteraction({
          screenPoint: (point, captured) => viewer.screenPoint(point.x, point.y, captured),
          touch: (phase, point) => client.current?.sendTouch(phase, point.x, point.y),
          orbit: viewer.orbit,
          zoomBy: viewer.zoomBy,
        });
        trackpad = bindPhoneTrackpad(canvas, interactionRef.current);
        resize();
        viewer.frameUpdated();
      })
      .catch(() => {
        if (!disposed) onUnavailable();
      });
    return () => {
      disposed = true;
      trackpad?.dispose();
      interactionRef.current?.end();
      interactionRef.current = null;
      onInputCancel(null);
      onResetReady(null);
      onFrameListener(null);
      observer.disconnect();
      window.removeEventListener("blur", blur);
      viewerRef.current?.dispose();
      viewerRef.current = null;
    };
  }, [
    onInputCancel,
    onResetReady,
    client,
    onFrameListener,
    onUnavailable,
    source,
    onFramingAspect,
  ]);

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  };
  return (
    <div className="absolute inset-0">
      <div
        ref={hostRef}
        className="absolute inset-0"
        style={{ translate: `${props.contentOffset}px 0` }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-[6%] left-1/2 h-5 w-2/5 -translate-x-1/2 rounded-full bg-foreground/10 blur-xl"
        />
        <canvas
          ref={canvasRef}
          aria-label="Interactive 3D device. Drag the screen to interact. Drag outside it or swipe with two fingers to turn. Pinch to zoom."
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
