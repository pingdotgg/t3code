import {
  AmbientLight,
  Box3,
  CanvasTexture,
  DirectionalLight,
  LinearFilter,
  Matrix4,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import {
  createDeviceModelSlot,
  type DeviceModelSource,
  type DeviceAccessorySource,
} from "./model.ts";
import { createImportedPhoneScene, loadDeviceModel } from "./modelScene.ts";
import { createPhoneScene, phoneDisplayLayout } from "./phoneScene.ts";
import {
  createAndroidFoldScene,
  DEFAULT_FOLD_INNER_ASPECT,
  isFoldInnerAspect,
} from "./androidFoldScene.ts";
import { createRenderScheduler } from "./renderScheduler.ts";
import { createDeviceMotion } from "./deviceMotion.ts";
import { createDeviceFraming } from "./deviceFraming.ts";
import { nearestDeviceView } from "./deviceViewSnap.ts";
import type { DeviceScreenSize } from "./stream.ts";
import { IOS_PHONE_SHAPE, type DeviceShapeProfile } from "./shapeProfile.ts";

export interface PhoneViewer {
  readonly setModel: (source: DeviceModelSource | null) => void;
  readonly setAccessory: (source: DeviceAccessorySource | null) => void;
  readonly frameUpdated: () => void;
  readonly setScreen: (screen: DeviceScreenSize | null, profile?: DeviceShapeProfile) => void;
  readonly setFoldAngle: (angle: number | null) => void;
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

const ANDROID_ORIENTATION_TURN_MS = 450;
const ANDROID_FOLD_TURN_MS = 850;

/** Owns only presentation resources. The caller retains the decoded canvas and the stream connection. */
export function createPhoneViewer(options: {
  readonly canvas: HTMLCanvasElement;
  readonly source: HTMLCanvasElement;
  readonly onUnavailable: () => void;
  readonly onModelError?: (cause: unknown) => void;
  readonly onFramingAspect?: (aspect: number) => void;
  readonly profile?: DeviceShapeProfile;
  readonly model?: DeviceModelSource | null;
  readonly accessory?: DeviceAccessorySource | null;
  readonly foldAngle?: number | null;
}): PhoneViewer {
  const renderer = new WebGLRenderer({
    canvas: options.canvas,
    alpha: true,
    antialias: true,
    powerPreference: "low-power",
  });
  renderer.outputColorSpace = SRGBColorSpace;
  const makeTexture = () => {
    const next = new CanvasTexture(options.source);
    next.colorSpace = SRGBColorSpace;
    next.minFilter = LinearFilter;
    next.magFilter = LinearFilter;
    next.generateMipmaps = false;
    return next;
  };
  let texture = makeTexture();
  let textureWidth = options.source.width;
  let textureHeight = options.source.height;
  const scene = new Scene();
  const camera = new PerspectiveCamera(32, 1, 0.1, 30);
  camera.position.z = 5.5;
  const ambient = new AmbientLight(0xffffff, 2.4);
  const key = new DirectionalLight(0xe4edff, 5);
  key.position.set(-3, 4, 5);
  const rim = new DirectionalLight(0xffffff, 4);
  rim.position.set(3, 1, -3);
  const fill = new DirectionalLight(0x9facd4, 2);
  fill.position.set(-2, -2, -4);
  scene.add(ambient, key, rim, fill);

  let screen: DeviceScreenSize | null = null;
  let layout = phoneDisplayLayout(screen, options.source.width, options.source.height);
  let profile = options.profile ?? IOS_PHONE_SHAPE;
  let foldAngle = options.foldAngle ?? null;
  let orientationAngle =
    foldAngle !== null && profile.id.startsWith("android") ? 0 : layout.rotation;
  let orientationTurn: { from: number; to: number; startedAt: number } | null = null;
  let imported: Awaited<ReturnType<typeof loadDeviceModel>> | null = null;
  let modelSource = options.model ?? null;
  let accessory: Awaited<ReturnType<typeof loadDeviceModel>> | null = null;
  let accessoryBounds: Box3 | null = null;
  let foldTurn: { from: number; to: number; startedAt: number } | null = null;
  // The inner display's raw width over height. Cover frames leave the last unfolded shape.
  const rawAspect = () => options.source.width / options.source.height;
  let foldAspect = isFoldInnerAspect(rawAspect()) ? rawAspect() : DEFAULT_FOLD_INNER_ASPECT;
  const createFoldScene = (angle: number, displayLayout = layout) =>
    createAndroidFoldScene(texture, displayLayout, angle, foldAspect);
  /** The hinge angle currently on screen, including an unfinished turn. */
  const visibleFoldAngle = (fallback: number) => {
    if (!foldTurn) return fallback;
    const progress = Math.min(1, (performance.now() - foldTurn.startedAt) / ANDROID_FOLD_TURN_MS);
    const eased = progress * progress * (3 - 2 * progress);
    return foldTurn.from + (foldTurn.to - foldTurn.from) * eased;
  };
  let phone: ReturnType<typeof createPhoneScene> | ReturnType<typeof createAndroidFoldScene> =
    foldAngle !== null && profile.id.startsWith("android")
      ? createFoldScene(foldAngle)
      : createPhoneScene(texture, layout, profile);
  scene.add(phone.root);
  let disposed = false;
  const rest = new Quaternion();
  const motion = createDeviceMotion({
    choose: (rotation) =>
      nearestDeviceView(rotation, [{ rotation: new Quaternion(), yawLimit: Math.PI / 3 }])!
        .rotation,
  });
  motion.setPose(rest, performance.now(), true);
  const framing = createDeviceFraming();
  const reducedMotion = () =>
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  let viewport = { width: 0, height: 0, pixelRatio: 1 };
  let drawingBuffer = { width: 0, height: 0, pixelRatio: 0 };

  let framingAspect: number | null = null;
  const fit = (immediate = false) => {
    if (!viewport.width || !viewport.height) return;
    camera.aspect = viewport.width / viewport.height;
    const bounds = new Box3(
      new Vector3(-phone.width / 2, -phone.height / 2, 0),
      new Vector3(phone.width / 2, phone.height / 2, 0),
    );
    if (imported && accessoryBounds) bounds.union(accessoryBounds);
    bounds.applyMatrix4(new Matrix4().makeRotationZ(orientationAngle));
    const size = bounds.getSize(new Vector3());
    const aspect = size.x / size.y;
    if (aspect !== framingAspect) {
      framingAspect = aspect;
      options.onFramingAspect?.(aspect);
    }
    phone.root.updateMatrixWorld(true);
    framing.setBounds(
      new Box3().setFromObject(phone.root),
      (camera.fov * Math.PI) / 360,
      camera.aspect,
      performance.now(),
      immediate,
    );
    applyCamera();
  };
  const applyCamera = () => {
    camera.position.set(framing.center.x, framing.center.y, framing.distance());
    camera.lookAt(framing.center.x, framing.center.y, 0);
    camera.updateProjectionMatrix();
  };
  const applyPose = () => {
    phone.root.quaternion.copy(motion.rotation);
    phone.orientation.rotation.z = orientationAngle;
  };
  const scheduler = createRenderScheduler(() => {
    if (disposed || !viewport.width || !viewport.height) return;
    try {
      if (
        drawingBuffer.width !== viewport.width ||
        drawingBuffer.height !== viewport.height ||
        drawingBuffer.pixelRatio !== viewport.pixelRatio
      ) {
        // Canvas allocation clears the previous image. Commit it with the redraw,
        // rather than exposing an empty buffer between ResizeObserver and the next frame.
        renderer.setDrawingBufferSize(viewport.width, viewport.height, viewport.pixelRatio);
        drawingBuffer = viewport;
      }
      const now = performance.now();
      if (motion.advance(now, reducedMotion())) {
        applyPose();
        fit(reducedMotion());
      }
      if (orientationTurn) {
        const progress = Math.min(
          1,
          (now - orientationTurn.startedAt) / ANDROID_ORIENTATION_TURN_MS,
        );
        const eased = progress * progress * (3 - 2 * progress);
        orientationAngle =
          orientationTurn.from + (orientationTurn.to - orientationTurn.from) * eased;
        if (progress === 1) orientationTurn = null;
        applyPose();
        fit(reducedMotion());
      }
      if (foldTurn && "setAngle" in phone) {
        const progress = Math.min(1, (now - foldTurn.startedAt) / ANDROID_FOLD_TURN_MS);
        const eased = progress * progress * (3 - 2 * progress);
        phone.setAngle(foldTurn.from + (foldTurn.to - foldTurn.from) * eased);
        if (progress === 1) foldTurn = null;
        fit(reducedMotion());
      }
      framing.advance(now, reducedMotion());
      applyCamera();
      renderer.render(scene, camera);
      if (motion.needsFrame() || framing.needsFrame() || orientationTurn || foldTurn)
        scheduler.invalidate();
    } catch {
      options.onUnavailable();
    }
  });
  const updateLayout = (nextProfile = profile) => {
    const next = phoneDisplayLayout(screen, options.source.width, options.source.height);
    const resized =
      textureWidth !== options.source.width || textureHeight !== options.source.height;
    if (
      resized ||
      nextProfile !== profile ||
      next.aspect !== layout.aspect ||
      next.rawLandscape !== layout.rawLandscape ||
      next.rotation !== layout.rotation
    ) {
      // The model and renderer survive framebuffer rotation and native resolution changes.
      if (resized) {
        const previous = texture;
        texture = makeTexture();
        textureWidth = options.source.width;
        textureHeight = options.source.height;
        phone.setDisplay(texture, next);
        previous.dispose();
      }
      // Learn the inner display shape from any unfolded frame, including before fold mode.
      const frameAspect = rawAspect();
      const innerChanged = isFoldInnerAspect(frameAspect) && frameAspect !== foldAspect;
      if (innerChanged) foldAspect = frameAspect;
      if (!imported && "setAngle" in phone && innerChanged) {
        // A new inner display shape resizes the body; the hinge keeps its visible angle.
        const angle = visibleFoldAngle(foldAngle ?? 180);
        scene.remove(phone.root);
        phone.dispose();
        phone = createFoldScene(angle, next);
        scene.add(phone.root);
      } else if (
        !imported &&
        !("setAngle" in phone) &&
        (nextProfile !== profile || next.aspect !== layout.aspect)
      ) {
        scene.remove(phone.root);
        phone.dispose();
        phone = createPhoneScene(texture, next, nextProfile);
        scene.add(phone.root);
      } else {
        phone.setDisplay(texture, next);
      }
      if (next.rotation !== layout.rotation) {
        if (nextProfile.id.startsWith("android") && !("setAngle" in phone) && !reducedMotion()) {
          const difference = Math.atan2(
            Math.sin(next.rotation - orientationAngle),
            Math.cos(next.rotation - orientationAngle),
          );
          orientationTurn = {
            from: orientationAngle,
            to: orientationAngle + difference,
            startedAt: performance.now(),
          };
        } else {
          orientationTurn = null;
          orientationAngle = "setAngle" in phone ? 0 : next.rotation;
        }
      }
      layout = next;
      profile = nextProfile;
      applyPose();
      fit(!orientationTurn);
    }
    applyPose();
  };
  const modelSlot = createDeviceModelSlot({
    load: loadDeviceModel,
    onError: options.onModelError,
    install(model) {
      // Validate and prepare the next scene before releasing the visible one.
      const next = disposed
        ? null
        : model
          ? createImportedPhoneScene(model.asset, texture, layout)
          : foldAngle !== null && profile.id.startsWith("android")
            ? createFoldScene(foldAngle)
            : createPhoneScene(texture, layout, profile);
      foldTurn = null;
      scene.remove(phone.root);
      phone.dispose();
      imported = model;
      if (!next) return;
      phone = next;
      scene.add(phone.root);
      if (accessory) {
        if (imported) phone.orientation.add(accessory.asset);
        else accessory.asset.removeFromParent();
      }
      applyPose();
      fit(true);
      scheduler.invalidate();
    },
  });
  const accessorySlot = createDeviceModelSlot({
    load: loadDeviceModel,
    onError: options.onModelError,
    install(model) {
      const bounds = model ? new Box3().setFromObject(model.asset) : null;
      if (
        bounds &&
        (bounds.isEmpty() ||
          ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite))
      )
        throw new Error("Device accessory has invalid bounds");
      accessory?.asset.removeFromParent();
      accessory = model;
      accessoryBounds = bounds;
      if (disposed) return;
      if (imported && accessory) phone.orientation.add(accessory.asset);
      fit(true);
      scheduler.invalidate();
    },
  });
  const setAccessory = (source: DeviceAccessorySource | null) => {
    accessorySlot.set(source?.modelId === modelSource?.id ? source : null);
  };
  const contextLost = (event: Event) => {
    event.preventDefault();
    options.onUnavailable();
  };
  options.canvas.addEventListener("webglcontextlost", contextLost);
  applyPose();
  modelSlot.set(options.model ?? null);
  setAccessory(options.accessory ?? null);
  return {
    setModel(source) {
      if (source?.id !== modelSource?.id || source?.url !== modelSource?.url)
        accessorySlot.set(null);
      modelSource = source;
      modelSlot.set(source);
    },
    setAccessory,
    setFoldAngle(next) {
      if (disposed || next === foldAngle) return;
      const previous = foldAngle;
      foldAngle = next;
      // A loaded model owns the scene; install() reads foldAngle if it is removed.
      if (imported) return;
      if (next === null || !("setAngle" in phone)) {
        scene.remove(phone.root);
        phone.dispose();
        phone = next === null ? createPhoneScene(texture, layout, profile) : createFoldScene(next);
        scene.add(phone.root);
        orientationTurn = null;
        orientationAngle = next === null ? layout.rotation : 0;
        foldTurn = null;
        applyPose();
        fit(true);
      } else {
        const from = visibleFoldAngle(previous ?? next);
        if (reducedMotion()) {
          foldTurn = null;
          phone.setAngle(next);
          fit(true);
        } else {
          foldTurn = { from, to: next, startedAt: performance.now() };
        }
      }
      scheduler.invalidate();
    },
    frameUpdated() {
      if (disposed) return;
      updateLayout();
      texture.needsUpdate = true;
      scheduler.invalidate();
    },
    setScreen(next, nextProfile = profile) {
      if (disposed) return;
      screen = next;
      updateLayout(nextProfile);
      scheduler.invalidate();
    },
    resize(width, height, pixelRatio) {
      if (disposed) return;
      if (![width, height, pixelRatio].every(Number.isFinite) || width <= 0 || height <= 0) return;
      const ratio = Math.min(2, Math.max(1, pixelRatio));
      if (viewport.width === width && viewport.height === height && viewport.pixelRatio === ratio)
        return;
      viewport = { width, height, pixelRatio: ratio };
      fit(true);
      scheduler.invalidate();
    },
    screenPoint(x, y, captured = false) {
      if (disposed) return null;
      applyPose();
      return phone.screenPoint(x, y, camera, captured);
    },
    orbit(deltaX, deltaY) {
      if (disposed) return;
      motion.orbit(deltaX * viewport.width, deltaY * viewport.height, performance.now());
      scheduler.invalidate();
    },
    setInteractionActive(active, mode) {
      if (disposed) return;
      const now = performance.now();
      if (mode === "orbit") motion.dragActive(active, now);
      else {
        motion.hold(active, now);
        framing.hold(active, now);
      }
      scheduler.invalidate();
    },
    resetPose() {
      if (disposed) return;
      motion.reset(rest, performance.now());
      scheduler.invalidate();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scheduler.dispose();
      const hadImported = imported !== null;
      accessorySlot.dispose();
      modelSlot.dispose();
      options.canvas.removeEventListener("webglcontextlost", contextLost);
      scene.remove(phone.root);
      if (!hadImported) phone.dispose();
      texture.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
