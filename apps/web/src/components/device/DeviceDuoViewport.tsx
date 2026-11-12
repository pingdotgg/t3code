import { useEffect, useRef } from "react";
import type { DuoViewer } from "@t3tools/client-runtime/device/duo-viewer";
import type { DeviceModelSource } from "@t3tools/client-runtime/device/model";
import type { createPhoneInteraction } from "@t3tools/client-runtime/device/phone-interaction";
import { createCanvasFrameSink } from "@t3tools/client-runtime/device/frame";
import type { DeviceScreenSize, DeviceStreamClient } from "@t3tools/client-runtime/device/stream";
import { createDuoPinch } from "@t3tools/client-runtime/device/duo-control";
import { mountDeviceViewer } from "./mountDeviceViewer";

const loadDuoViewer = () => import("@t3tools/client-runtime/device/duo-viewer");

export function DeviceDuoViewport(props: {
  readonly model: DeviceModelSource;
  readonly source: HTMLCanvasElement;
  readonly onFrameListener: (listener: (() => void) | null) => void;
  readonly onResetReady: (reset: (() => void) | null) => void;
  readonly onInputCancel: (cancel: (() => void) | null) => void;
  readonly client: DeviceStreamClient;
  readonly screen: DeviceScreenSize | null;
  readonly hingePreview: number | null;
  readonly onControlRejectedListener: (listener: (() => void) | null) => void;
  readonly onUnavailable: () => void;
}) {
  const viewerRef = useRef<
    (DuoViewer & { readonly sources: Record<1 | 3, HTMLCanvasElement> }) | null
  >(null);
  const interactionRef = useRef<ReturnType<typeof createPhoneInteraction> | null>(null);
  const pinchRef = useRef<ReturnType<typeof createDuoPinch> | null>(null);
  const screenRef = useRef(props.screen);
  const modelRef = useRef(props.model);
  const previewRef = useRef(props.hingePreview);
  const {
    source,
    client,
    onInputCancel,
    onControlRejectedListener,
    onResetReady,
    onUnavailable,
    onFrameListener,
  } = props;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stores screen and model in refs, ends any active interaction, and pushes the screen into the 3D Duo viewer
  useEffect(() => {
    screenRef.current = props.screen;
    modelRef.current = props.model;
    interactionRef.current?.end();
    viewerRef.current?.setScreen(props.screen);
  }, [props.screen, props.model]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the hinge preview into the imperative 3D Duo viewer unless a pinch is active
  useEffect(() => {
    previewRef.current = props.hingePreview;
    if (!pinchRef.current?.active) viewerRef.current?.setHingePreview(props.hingePreview);
  }, [props.hingePreview]);

  // The 3D viewer lives as long as its canvas; later prop changes are pushed into it above.
  const mountViewer = (canvas: HTMLCanvasElement | null) => {
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    return mountDeviceViewer(canvas, host, {
      load: () =>
        loadDuoViewer().then(({ createDuoViewer }) => () => {
          const sources = {
            1: document.createElement("canvas"),
            3: document.createElement("canvas"),
          };
          const viewer = createDuoViewer({
            canvas,
            sources,
            onUnavailable,
            onPanelRequested: (panel) =>
              client.controlDuo({
                control: "physical",
                value: panel === 1 ? "facedown" : "faceup",
              }),
            onOrientationRequested: (value) => client.controlDuo({ control: "orientation", value }),
            onModelError: (cause) => console.warn("Device 3D asset could not load", cause),
            model: modelRef.current,
          });
          return { ...viewer, sources };
        }),
      touch: (phase, point) => client.sendRawTouch(phase, point.x, point.y),
      viewerRef,
      interactionRef,
      onInputCancel,
      onResetReady,
      onFrameListener,
      onUnavailable,
      cancelInput: (viewer) => viewer.cancelInput(),
      ready: ({ viewer, cancelTrackpad }) => {
        onControlRejectedListener(() => {
          cancelTrackpad();
          viewer.rejectOrientation();
        });
        viewer.setScreen(screenRef.current);
        viewer.setHingePreview(previewRef.current);
        client.setDuoPanels({
          onScreen(next) {
            screenRef.current = next;
            interactionRef.current?.end();
            viewer.setScreen(next);
          },
          cover: createCanvasFrameSink(viewer.sources[1], () => viewer.frameUpdated(1)),
          inner: createCanvasFrameSink(viewer.sources[3], () => viewer.frameUpdated(3)),
        });
        const pinch = createDuoPinch({
          angle: () =>
            previewRef.current ??
            screenRef.current?.hingeAngle ??
            (screenRef.current?.screenId === 1 ? 0 : 180),
          contains: (x, y) => !!screenRef.current && viewer.beginHinge(x, y),
          change: (angle) => {
            viewer.setHingePreview(angle ?? previewRef.current, true);
            if (angle !== null) client.controlDuo({ control: "angle", value: angle });
          },
        });
        pinchRef.current = pinch;
        return {
          frame: () => {
            const panel = screenRef.current?.screenId;
            if (panel === 1 || panel === 3) viewer.frameUpdated(panel, source);
          },
          pinch: {
            begin(x, y) {
              interactionRef.current?.end();
              return pinch.begin(x, y);
            },
            move: pinch.move,
            end: pinch.end,
          },
          dispose: () => {
            pinchRef.current = null;
            onControlRejectedListener(null);
            client.setDuoPanels(null);
          },
        };
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
