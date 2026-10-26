import { createPhoneInteraction } from "@t3tools/client-runtime/device/phone-interaction";
import { observeResize } from "../../lib/observeResize";
import { bindPhoneTrackpad } from "./phoneTrackpad";

type PhoneInteraction = ReturnType<typeof createPhoneInteraction>;
type TrackpadPinch = NonNullable<Parameters<typeof bindPhoneTrackpad>[2]>;

interface MountableViewer {
  readonly resize: (width: number, height: number, pixelRatio: number) => void;
  readonly screenPoint: (
    x: number,
    y: number,
    captured?: boolean,
  ) => { x: number; y: number } | null;
  readonly orbit: (deltaX: number, deltaY: number) => void;
  readonly setInteractionActive: (active: boolean, mode: "touch" | "orbit") => void;
  readonly resetPose: () => void;
  readonly dispose: () => void;
}

export interface DeviceViewerReady {
  /** Draws the latest decoded frame; registered as the stream's frame listener. */
  readonly frame: () => void;
  readonly pinch?: TrackpadPinch;
  readonly dispose?: () => void;
}

/**
 * Mounts a lazily loaded 3D device viewer on a canvas and returns its teardown, for use from
 * the canvas ref callback. Owns host resizing, input cancellation, trackpad gestures, and
 * disposal shared by every viewport.
 */
export function mountDeviceViewer<V extends MountableViewer>(
  canvas: HTMLCanvasElement,
  host: HTMLElement,
  options: {
    /** Resolves to the constructor, so a canvas unmounted while loading never builds a viewer. */
    readonly load: () => Promise<() => V>;
    readonly touch: (phase: "begin" | "move" | "end", point: { x: number; y: number }) => void;
    readonly viewerRef: { current: V | null };
    readonly interactionRef: { current: PhoneInteraction | null };
    readonly onInputCancel: (cancel: (() => void) | null) => void;
    readonly onResetReady: (reset: (() => void) | null) => void;
    readonly onFrameListener: (listener: (() => void) | null) => void;
    readonly onUnavailable: () => void;
    readonly cancelInput?: (viewer: V) => void;
    readonly ready: (context: {
      readonly viewer: V;
      readonly cancelTrackpad: () => void;
    }) => DeviceViewerReady;
  },
) {
  const { viewerRef, interactionRef } = options;
  let disposed = false;
  let trackpad: ReturnType<typeof bindPhoneTrackpad> | null = null;
  let stopTrackpadEnd: (() => void) | undefined;
  let mounted: DeviceViewerReady | null = null;
  const resize = () => {
    const { width, height } = host.getBoundingClientRect();
    viewerRef.current?.resize(width, height, window.devicePixelRatio);
  };
  const stopObserving = observeResize(host, resize);
  const blur = () => {
    interactionRef.current?.end();
    trackpad?.cancel();
    if (viewerRef.current) options.cancelInput?.(viewerRef.current);
  };
  options.onInputCancel(blur);
  window.addEventListener("blur", blur);
  void options
    .load()
    .then((create) => {
      if (disposed) return;
      const viewer = create();
      viewerRef.current = viewer;
      options.onResetReady(viewer.resetPose);
      const interaction = createPhoneInteraction({
        screenPoint: (point, captured) => viewer.screenPoint(point.x, point.y, captured),
        touch: options.touch,
        orbit: viewer.orbit,
        zoomBy: () => {},
        onInteractionActive: viewer.setInteractionActive,
      });
      interactionRef.current = interaction;
      resize();
      mounted = options.ready({ viewer, cancelTrackpad: () => trackpad?.cancel() });
      options.onFrameListener(mounted.frame);
      mounted.frame();
      trackpad = bindPhoneTrackpad(canvas, interaction, mounted.pinch);
      stopTrackpadEnd = window.desktopBridge?.onTrackpadScrollEnd?.(() => trackpad?.endOrbit());
    })
    .catch(() => {
      if (!disposed) options.onUnavailable();
    });
  return () => {
    disposed = true;
    stopTrackpadEnd?.();
    trackpad?.dispose();
    mounted?.dispose?.();
    interactionRef.current?.end();
    interactionRef.current = null;
    options.onInputCancel(null);
    options.onResetReady(null);
    options.onFrameListener(null);
    stopObserving();
    window.removeEventListener("blur", blur);
    viewerRef.current?.dispose();
    viewerRef.current = null;
  };
}
