// @effect-diagnostics globalTimers:off - Native display handoff has a bounded acknowledgement window.
import {
  AmbientLight,
  Box3,
  CanvasTexture,
  DirectionalLight,
  Euler,
  LinearFilter,
  PerspectiveCamera,
  PMREMGenerator,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { createDuoScene, duoDisplayKey, duoFrameMatches, type DuoPanelId } from "./duoScene.ts";
import { loadDeviceModel } from "./modelScene.ts";
import { createDeviceModelSlot, type DeviceModelSource } from "./model.ts";
import { createDuoFraming } from "./duoFraming.ts";
import { createDuoMotion } from "./duoMotion.ts";
import { duoViewSnaps, nearestDuoView, type DuoRestFace } from "./duoSnap.ts";
import { createRenderScheduler } from "./renderScheduler.ts";
import type { DeviceScreenSize } from "./stream.ts";
import type { DuoPose } from "./duoControl.ts";

export interface DuoViewer {
  readonly setScreen: (screen: DeviceScreenSize | null) => void;
  readonly setHingePreview: (angle: number | null) => void;
  readonly setInteractionActive: (active: boolean, mode?: "touch" | "orbit") => void;
  readonly rejectOrientation: () => void;
  readonly frameUpdated: (panel: DuoPanelId, primary?: HTMLCanvasElement) => void;
  readonly resize: (width: number, height: number, pixelRatio: number) => void;
  readonly screenPoint: (
    x: number,
    y: number,
    captured?: boolean,
  ) => { x: number; y: number } | null;
  readonly orbit: (x: number, y: number) => void;
  readonly containsDevice: (x: number, y: number) => boolean;
  readonly resetPose: () => void;
  readonly cancelInput: () => void;
  readonly dispose: () => void;
}

/** On-demand renderer for the articulated body. One inner framebuffer spans both leaves; HID belongs to the stream. */
export function createDuoViewer(options: {
  canvas: HTMLCanvasElement;
  sources: Record<DuoPanelId, HTMLCanvasElement>;
  model: DeviceModelSource;
  onUnavailable: () => void;
  onModelError?: (cause: unknown) => void;
  onPanelRequested?: (panel: DuoPanelId) => void;
  onOrientationRequested?: (orientation: DeviceScreenSize["orientation"]) => void;
}): DuoViewer {
  const surfaces = ([1, 3] as const)
    .map((id) => {
      const canvas = document.createElement("canvas");
      canvas.width = id === 1 ? 784 : 1600;
      canvas.height = id === 1 ? 1140 : 1125;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Duo display canvas is unavailable");
      context.fillStyle = "#080a10";
      context.fillRect(0, 0, canvas.width, canvas.height);
      return { id, canvas, context };
    })
    .map(({ id, canvas, context }) => {
      const texture = new CanvasTexture(canvas);
      texture.colorSpace = SRGBColorSpace;
      texture.minFilter = texture.magFilter = LinearFilter;
      texture.generateMipmaps = false;
      return { id, canvas, context, texture };
    });
  const renderer = new WebGLRenderer({
    canvas: options.canvas,
    alpha: true,
    antialias: true,
    powerPreference: "low-power",
  });
  renderer.outputColorSpace = SRGBColorSpace;
  const scene = new Scene();
  const environment = (() => {
    const generator = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    try {
      return generator.fromScene(room, 0.04);
    } catch (cause) {
      for (const surface of surfaces) surface.texture.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      throw cause;
    } finally {
      room.dispose();
      generator.dispose();
    }
  })();
  scene.environment = environment.texture;
  const camera = new PerspectiveCamera(36, 1, 0.1, 150);
  const key = new DirectionalLight(0xffffff, 4);
  key.position.set(-6, 10, 14);
  const fill = new DirectionalLight(0xc7dcff, 2);
  fill.position.set(8, -3, -5);
  scene.add(new AmbientLight(0xffffff, 2.4), key, fill);
  let model: ReturnType<typeof createDuoScene> | null = null;
  let screen: DeviceScreenSize | null = null;
  let readyKey = "";
  let primaryKey = "";
  let activationAt = 0;
  let disposed = false;
  let viewport = { width: 0, height: 0, ratio: 1 };
  let buffer = { width: 0, height: 0, ratio: 0 };
  let restFace: DuoRestFace = "inside";
  let requestedOrientation: DeviceScreenSize["orientation"] | null = null;
  let viewOrientation: DeviceScreenSize["orientation"] | null = null;
  const pivot = new Vector3();
  const targetPivot = new Vector3();
  let requestedPanel: DuoPanelId | null = null;
  let handoffTimer: ReturnType<typeof setTimeout> | null = null;
  const clearHandoff = () => {
    if (handoffTimer) clearTimeout(handoffTimer);
    handoffTimer = null;
    requestedPanel = null;
  };
  const activeSnaps = () =>
    model
      ? duoViewSnaps(
          model.restFrames(screen?.screenId === 1 ? 1 : 3),
          screen?.screenId === 1 ? 1 : 3,
        )
      : [];
  const snaps = () => {
    if (!model || !screen?.supportsPhysicalOrientation || !options.onPanelRequested)
      return activeSnaps();
    const cover = duoViewSnaps(model.restFrames(1), 1);
    // A shut inner display is occluded and cannot become a useful rest view.
    return angle > 20 && angle < 180
      ? [...duoViewSnaps(model.restFrames(3), 3), ...cover]
      : activeSnaps();
  };
  const orbit = createDuoMotion({
    choose(rotation) {
      const snap = nearestDuoView(rotation, snaps());
      if (!snap) return rotation;
      restFace = snap.face;
      const panel = snap.face === "cover" ? 1 : 3;
      if (screen && panel !== (requestedPanel ?? screen.screenId) && options.onPanelRequested) {
        clearHandoff();
        requestedPanel = panel;
        model?.cancelInput();
        options.onPanelRequested(panel);
        handoffTimer = setTimeout(() => {
          clearHandoff();
          const confirmed = nearestDuoView(orbit.rotation, activeSnaps());
          if (confirmed) {
            restFace = confirmed.face;
            orbit.setPose(confirmed.rotation, performance.now());
          }
          scheduler.invalidate();
        }, 5000);
      } else if (
        screen &&
        requestedPanel === null &&
        snap.orientation !== viewOrientation &&
        options.onOrientationRequested
      ) {
        viewOrientation = snap.orientation;
        requestedOrientation = snap.orientation;
        options.onOrientationRequested(snap.orientation);
      }
      return snap.rotation;
    },
  });
  let angle = 180;
  let targetAngle = 180;
  let previewAngle: number | null = null;
  let interactionActive = false;
  const framing = createDuoFraming();
  const framingBounds = new Box3();
  let firstPose = true;
  let physicalPose: DuoPose = "open";
  let presentationAngle = 180;
  let targetPresentation = new Quaternion();
  let lastTime = 0;
  const reduced =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const applyPose = () => {
    if (!model) return;
    model.setAngle(angle);
    model.root.quaternion.copy(orbit.rotation);
    model.root.position.set(0, 0, 0);
    const frames = model.restFrames(restFace === "cover" ? 1 : 3);
    const frame = frames.find((frame) => frame.face === restFace) ?? frames[0];
    targetPivot.copy(frame?.center ?? new Vector3());
    model.root.position.copy(pivot).applyQuaternion(model.root.quaternion).negate();
  };
  const updateCamera = () => {
    camera.position.set(framing.center.x, framing.center.y, framing.distance());
    camera.lookAt(framing.center.x, framing.center.y, 0);
    camera.updateProjectionMatrix();
  };
  const fit = (immediate = false) => {
    if (!model || !viewport.width || !viewport.height) return;
    camera.aspect = viewport.width / viewport.height;
    framing.setBounds(
      framingBounds.setFromObject(model.root),
      (camera.fov * Math.PI) / 360,
      camera.aspect,
      performance.now(),
      immediate,
    );
    updateCamera();
  };
  const moving = () =>
    Math.abs(angle - targetAngle) > 0.01 || pivot.distanceTo(targetPivot) > 0.001;
  const scheduler = createRenderScheduler(() => {
    if (disposed || !model || !viewport.width || !viewport.height) return;
    try {
      const now = performance.now();
      const elapsed = Math.max(0, (now - lastTime) / 1000);
      const amount = reduced
        ? 1
        : 1 - Math.exp(-14 * Math.max(0, (now - lastTime) / 1000 || 0.016));
      lastTime = now;
      const inMotion = moving();
      const orbitChanged = orbit.advance(now, reduced);
      if (inMotion) {
        angle += (targetAngle - angle) * amount;

        if (Math.abs(angle - targetAngle) <= 0.01) angle = targetAngle;
        applyPose();
        pivot.lerp(targetPivot, amount);
        if (pivot.distanceTo(targetPivot) <= 0.001) pivot.copy(targetPivot);
        applyPose();
        fit(reduced || elapsed > 0.5);
      }
      if (orbitChanged) {
        applyPose();
        fit(reduced || elapsed > 0.5);
      }
      if (framing.advance(now, reduced)) updateCamera();
      if (
        buffer.width !== viewport.width ||
        buffer.height !== viewport.height ||
        buffer.ratio !== viewport.ratio
      ) {
        renderer.setDrawingBufferSize(viewport.width, viewport.height, viewport.ratio);
        buffer = viewport;
      }
      renderer.render(scene, camera);
      if (inMotion || moving() || orbit.needsFrame() || framing.needsFrame())
        scheduler.invalidate();
    } catch {
      options.onUnavailable();
    }
  });
  const slot = createDeviceModelSlot({
    load: loadDeviceModel,
    onError(cause) {
      options.onModelError?.(cause);
      options.onUnavailable();
    },
    install(loaded) {
      const next = loaded
        ? createDuoScene(loaded.asset, { 1: surfaces[0]!.texture, 3: surfaces[1]!.texture })
        : null;
      if (model) {
        scene.remove(model.root);
        model.dispose();
      }
      model = next;
      if (!model || disposed) return;
      scene.add(model.root);
      applyPose();
      if (screen?.screenId === 1) {
        const snap = nearestDuoView(orbit.rotation, activeSnaps());
        if (snap) {
          restFace = snap.face;
          orbit.setPose(snap.rotation, performance.now(), true);
          applyPose();
        }
      }
      pivot.copy(targetPivot);
      applyPose();
      fit();
      scheduler.invalidate();
    },
  });
  const lost = (event: Event) => {
    event.preventDefault();
    options.onUnavailable();
  };
  options.canvas.addEventListener("webglcontextlost", lost);
  slot.set(options.model);
  return {
    setScreen(next) {
      if (disposed) return;
      const wasMoving = moving() || orbit.needsFrame();
      if (duoDisplayKey(screen) !== duoDisplayKey(next)) {
        readyKey = "";
        activationAt = performance.now();
        model?.cancelInput();
      }
      const previous = screen;
      const ownedHandoff = requestedPanel !== null;
      if (!next || next.screenId === requestedPanel) clearHandoff();
      const ownedRotation = requestedOrientation !== null && next?.screenId === previous?.screenId;
      const changedDisplay = next?.screenId !== previous?.screenId;
      requestedOrientation = null;
      screen = next;
      const changedPose = next?.hingePose && next.hingePose !== previous?.hingePose;
      const rotated =
        next?.screenId === previous?.screenId &&
        next?.hingeAngle === previous?.hingeAngle &&
        next?.orientation !== previous?.orientation;
      const leftPhysicalPose =
        rotated && !ownedRotation && !ownedHandoff && !next?.hingePose && previewAngle === null;
      if (firstPose || changedPose || leftPhysicalPose) {
        physicalPose = next?.hingePose ?? (next?.screenId === 1 ? "closed" : "open");
        presentationAngle = next?.hingeAngle ?? (next?.screenId === 1 ? 0 : 180);
      }
      // A command reply/config confirms hinge state. Display identity, never an angle heuristic, owns input.
      targetAngle = previewAngle ?? next?.hingeAngle ?? (next?.screenId === 1 ? 0 : 180);
      // Native angle commands clear hingePose. They change articulation only;
      // preserve the viewing pose, including laptop/tent and user orbit. A
      // separate rotation clears the physical preset and follows panel orientation.
      if (firstPose || changedPose || (rotated && !ownedRotation && !ownedHandoff)) {
        viewOrientation = next?.orientation ?? null;
        const poseAngle = presentationAngle;
        const fold = ((180 - poseAngle) * Math.PI) / 360;
        let roll = physicalPose === "closed" ? 0 : Math.PI / 2;
        if (next && next.width < next.height) {
          if (next.orientation === "landscape_left") roll -= Math.PI / 2;
          if (next.orientation === "landscape_right") roll += Math.PI / 2;
        }
        if (next?.orientation === "portrait_upside_down") roll -= Math.PI;
        const physical =
          physicalPose === "laptop"
            ? new Euler(-fold + Math.PI / 9, -Math.PI / 9, Math.PI / 2, "YXZ")
            : physicalPose === "tent"
              ? new Euler(Math.PI / 2 + Math.PI / 18, -Math.PI / 9, -Math.PI / 2, "YXZ")
              : new Euler(0, (Math.PI / 2) * Math.pow(1 - poseAngle / 180, 3), 0, "YXZ");
        targetPresentation = new Quaternion().setFromEuler(physical);
        if (physicalPose !== "laptop" && physicalPose !== "tent")
          targetPresentation.premultiply(
            new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), roll),
          );
        if (next?.screenId === 1) {
          // Native readback can retain the cover even for an open physical preset.
          // A screen-facing rest must use that display's actual hinged normal.
          const snap = nearestDuoView(targetPresentation, activeSnaps());
          if (snap) targetPresentation.copy(snap.rotation);
        }
        if (firstPose) angle = targetAngle;
        restFace = next?.screenId === 1 ? "cover" : physicalPose === "laptop" ? "right" : "inside";
        orbit.setPose(targetPresentation, performance.now(), firstPose);
        firstPose = false;
      } else if (next && changedDisplay && !ownedHandoff) {
        // A sensor rotation can hand ownership to the other native display.
        // Face that display without sending another rotation and creating a feedback loop.
        const snap = nearestDuoView(orbit.rotation, activeSnaps());
        if (snap) {
          restFace = snap.face;
          orbit.setPose(snap.rotation, performance.now());
        }
      }
      if (!wasMoving) lastTime = performance.now();
      applyPose();
      fit();
      scheduler.invalidate();
    },
    setHingePreview(next) {
      if (disposed || (next !== null && (!Number.isFinite(next) || next < 0 || next > 180))) return;
      if (!moving()) lastTime = performance.now();
      previewAngle = next;
      orbit.hold(interactionActive || next !== null, performance.now());
      targetAngle = next ?? screen?.hingeAngle ?? (screen?.screenId === 1 ? 0 : 180);
      if (next !== null) {
        angle = next;
        applyPose();
      }
      model?.cancelInput();
      scheduler.invalidate();
    },
    setInteractionActive(active, mode = "touch") {
      if (disposed) return;
      if (mode === "orbit") orbit.dragActive(active, performance.now());
      else {
        interactionActive = active;
        orbit.hold(active || previewAngle !== null, performance.now());
        framing.hold(active, performance.now());
      }
      scheduler.invalidate();
    },
    rejectOrientation() {
      if (disposed || (requestedOrientation === null && requestedPanel === null)) return;
      clearHandoff();
      requestedOrientation = null;
      viewOrientation = screen?.orientation ?? null;
      const confirmed = activeSnaps().filter((snap) => snap.orientation === screen?.orientation);
      const snap = nearestDuoView(orbit.rotation, confirmed);
      if (snap) {
        restFace = snap.face;
        orbit.setPose(snap.rotation, performance.now());
      }
      scheduler.invalidate();
    },
    frameUpdated(id, primary) {
      if (disposed || screen?.screenId !== id) return;
      const key = duoDisplayKey(screen);
      // The elected native feed is authoritative during handoff. Fixed-panel
      // encoders can retain an inactive blank until that surface changes again.
      if (!primary && primaryKey === key) return;
      const source = primary ?? options.sources[id];
      if (!duoFrameMatches(source, screen)) return;
      const surface = surfaces[id === 1 ? 0 : 1]!;
      const { context, canvas } = surface;
      // Ignore native shutdown blanks only while waiting for an activation. Steady black application content remains valid.
      if (!primary && !readyKey && performance.now() - activationAt < 1500) {
        const probe = document.createElement("canvas");
        probe.width = probe.height = 8;
        const probeContext = probe.getContext("2d", { willReadFrequently: true });
        if (probeContext) {
          probeContext.drawImage(source, 0, 0, 8, 8);
          if (
            !probeContext
              .getImageData(0, 0, 8, 8)
              .data.some((value, index) => index % 4 !== 3 && value > 3)
          )
            return;
        }
      }
      context.save();
      context.fillStyle = "#080a10";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.translate(canvas.width / 2, canvas.height / 2);
      if (id === 3) context.rotate(Math.PI / 2);
      const scale = Math.min(
        canvas.width / (id === 3 ? source.height : source.width),
        canvas.height / (id === 3 ? source.width : source.height),
      );
      context.drawImage(
        source,
        (-source.width * scale) / 2,
        (-source.height * scale) / 2,
        source.width * scale,
        source.height * scale,
      );
      context.restore();
      surface.texture.needsUpdate = true;
      readyKey = duoDisplayKey(screen);
      if (primary) primaryKey = readyKey;
      scheduler.invalidate();
    },
    resize(width, height, ratio) {
      if (disposed || ![width, height, ratio].every(Number.isFinite) || width <= 0 || height <= 0)
        return;
      viewport = { width, height, ratio: Math.min(2, Math.max(1, ratio)) };
      fit(true);
      scheduler.invalidate();
    },
    screenPoint(x, y, captured = false) {
      if (
        disposed ||
        moving() ||
        previewAngle !== null ||
        requestedOrientation !== null ||
        requestedPanel !== null
      )
        return null;
      applyPose();
      return model?.screenPoint(x, y, camera, screen, readyKey, captured) ?? null;
    },
    cancelInput() {
      model?.cancelInput();
    },
    orbit(x, y) {
      if (disposed) return;
      orbit.orbit(x * viewport.width, y * viewport.height, performance.now());
      scheduler.invalidate();
    },
    containsDevice(x, y) {
      return !disposed && !!model?.containsDevice(x, y, camera);
    },
    resetPose() {
      if (disposed) return;
      requestedOrientation = null;
      clearHandoff();
      const snap = activeSnaps().find((snap) => snap.orientation === screen?.orientation);
      if (snap && snap.orientation !== viewOrientation && options.onOrientationRequested) {
        viewOrientation = snap.orientation;
        requestedOrientation = snap.orientation;
        options.onOrientationRequested(snap.orientation);
      }
      orbit.reset(snap?.rotation ?? targetPresentation, performance.now());
      applyPose();
      fit();
      scheduler.invalidate();
    },
    dispose() {
      clearHandoff();
      if (disposed) return;
      disposed = true;
      scheduler.dispose();
      slot.dispose();
      options.canvas.removeEventListener("webglcontextlost", lost);
      for (const surface of surfaces) surface.texture.dispose();
      scene.environment = null;
      environment.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
