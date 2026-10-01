import { useEffect, useRef, type RefObject } from "react";
import type { DuoViewer } from "@t3tools/client-runtime/device/duo-viewer";
import type { DeviceModelSource } from "@t3tools/client-runtime/device/model";
import { createPhoneInteraction } from "@t3tools/client-runtime/device/phone-interaction";
import { createCanvasFrameSink } from "@t3tools/client-runtime/device/frame";
import type { DeviceScreenSize, DeviceStreamClient } from "@t3tools/client-runtime/device/stream";
import { createDuoPinch } from "@t3tools/client-runtime/device/duo-control";
import { bindPhoneTrackpad } from "./phoneTrackpad";

const loadDuoViewer = () => import("@t3tools/client-runtime/device/duo-viewer");

/** Web shell for the framework-independent viewer. The decoded screen and input connection remain owned by DeviceStreamView. */
export function DeviceDuoViewport(props: {
  readonly model: DeviceModelSource;
  readonly source: RefObject<HTMLCanvasElement | null>;
  readonly onFrameListener: (listener: (() => void) | null) => void;
  readonly onResetReady: (reset: (() => void) | null) => void;
  readonly onInputCancel: (cancel: (() => void) | null) => void;
  readonly client: RefObject<DeviceStreamClient | null>;
  readonly screen: DeviceScreenSize | null;
  readonly hingePreview: number | null;
  readonly controlError: string | null;
  readonly onUnavailable: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<DuoViewer | null>(null);
  const interactionRef = useRef<ReturnType<typeof createPhoneInteraction> | null>(null);
  const pinchRef = useRef<ReturnType<typeof createDuoPinch> | null>(null);
  const trackpadRef = useRef<ReturnType<typeof bindPhoneTrackpad> | null>(null);
  const screenRef = useRef(props.screen);
  const modelRef = useRef(props.model);
  const previewRef = useRef(props.hingePreview);
  const { source, client, onInputCancel, onResetReady, onUnavailable, onFrameListener } = props;

  useEffect(() => {
    screenRef.current = props.screen;
    modelRef.current = props.model;
    interactionRef.current?.end();
    viewerRef.current?.setScreen(props.screen);
  }, [props.screen, props.model]);

  useEffect(() => {
    if (props.controlError || !props.screen) {
      trackpadRef.current?.cancel();
      viewerRef.current?.rejectOrientation();
    }
  }, [props.controlError, props.screen]);

  useEffect(() => {
    previewRef.current = props.hingePreview;
    if (!pinchRef.current?.active) viewerRef.current?.setHingePreview(props.hingePreview);
  }, [props.hingePreview]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const decoded = source.current;
    if (!host || !canvas || !decoded) return;
    let disposed = false;
    let trackpad: ReturnType<typeof bindPhoneTrackpad> | null = null;
    let stopTrackpadEnd: (() => void) | undefined;
    const resize = () => {
      const { width, height } = host.getBoundingClientRect();
      viewerRef.current?.resize(width, height, window.devicePixelRatio);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const blur = () => {
      interactionRef.current?.end();
      trackpad?.cancel();
      viewerRef.current?.cancelInput();
    };
    onInputCancel(blur);
    window.addEventListener("blur", blur);
    void loadDuoViewer()
      .then(({ createDuoViewer }) => {
        if (disposed) return;
        const sources = {
          1: document.createElement("canvas"),
          3: document.createElement("canvas"),
        };
        const viewer = createDuoViewer({
          canvas,
          sources,
          onUnavailable,
          onPanelRequested: (panel) =>
            client.current?.controlDuo({
              control: "physical",
              value: panel === 1 ? "facedown" : "faceup",
            }),
          onOrientationRequested: (value) =>
            client.current?.controlDuo({ control: "orientation", value }),
          onModelError: (cause) => console.warn("Device 3D asset could not load", cause),
          model: modelRef.current,
        });
        viewerRef.current = viewer;
        onResetReady(viewer.resetPose);
        viewer.setScreen(screenRef.current);
        const primaryFrame = () => {
          const panel = screenRef.current?.screenId;
          if (panel === 1 || panel === 3) viewer.frameUpdated(panel, decoded);
        };
        onFrameListener(primaryFrame);
        primaryFrame();
        viewer.setHingePreview(previewRef.current);
        client.current?.setDuoPanels({
          onScreen(next) {
            screenRef.current = next;
            interactionRef.current?.end();
            viewer.setScreen(next);
          },
          cover: createCanvasFrameSink(sources[1], () => viewer.frameUpdated(1)),
          inner: createCanvasFrameSink(sources[3], () => viewer.frameUpdated(3)),
        });
        interactionRef.current = createPhoneInteraction({
          screenPoint: (point, captured) => viewer.screenPoint(point.x, point.y, captured),
          touch: (phase, point) => client.current?.sendRawTouch(phase, point.x, point.y),
          orbit: viewer.orbit,
          zoomBy: () => {},
          onInteractionActive: viewer.setInteractionActive,
        });
        const pinch = createDuoPinch({
          angle: () =>
            previewRef.current ??
            screenRef.current?.hingeAngle ??
            (screenRef.current?.screenId === 1 ? 0 : 180),
          contains: (x, y) => !!screenRef.current && viewer.beginHinge(x, y),
          change: (angle) => {
            viewer.setHingePreview(angle ?? previewRef.current);
            if (angle !== null) client.current?.controlDuo({ control: "angle", value: angle });
          },
        });
        pinchRef.current = pinch;
        trackpad = bindPhoneTrackpad(canvas, interactionRef.current, {
          begin(x, y) {
            interactionRef.current?.end();
            return pinch.begin(x, y);
          },
          move: pinch.move,
          end: pinch.end,
        });
        trackpadRef.current = trackpad;
        stopTrackpadEnd = window.desktopBridge?.onTrackpadScrollEnd?.(() => trackpad?.endOrbit());
        resize();
      })
      .catch(() => {
        if (!disposed) onUnavailable();
      });
    return () => {
      disposed = true;
      stopTrackpadEnd?.();
      trackpad?.dispose();
      trackpadRef.current = null;
      pinchRef.current = null;
      interactionRef.current?.end();
      interactionRef.current = null;
      onInputCancel(null);
      onResetReady(null);
      onFrameListener(null);
      client.current?.setDuoPanels(null);
      observer.disconnect();
      window.removeEventListener("blur", blur);
      viewerRef.current?.dispose();
      viewerRef.current = null;
    };
  }, [onInputCancel, onResetReady, client, onUnavailable, source, onFrameListener]);

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  };
  return (
    <div className="absolute inset-0">
      <div ref={hostRef} className="absolute inset-0">
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-[6%] left-1/2 h-5 w-2/5 -translate-x-1/2 rounded-full bg-foreground/10 blur-xl"
        />
        <canvas
          ref={canvasRef}
          aria-label="Interactive 3D iPhone Duo. Drag the screen to interact. Drag outside it or swipe with two fingers to turn. Pinch over the device to open or close its hinge."
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
