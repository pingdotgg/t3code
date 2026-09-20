import {
  AmbientLight,
  Box3,
  CanvasTexture,
  DirectionalLight,
  LinearFilter,
  Matrix4,
  PerspectiveCamera,
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
import { createRenderScheduler } from "./renderScheduler.ts";
import { createPhonePose } from "./phonePose.ts";
import type { DeviceScreenSize } from "./stream.ts";
import { IOS_PHONE_SHAPE, type DeviceShapeProfile } from "./shapeProfile.ts";

export interface PhoneViewer {
  readonly setModel: (source: DeviceModelSource | null) => void;
  readonly setAccessory: (source: DeviceAccessorySource | null) => void;
  readonly frameUpdated: () => void;
  readonly setScreen: (screen: DeviceScreenSize | null, profile?: DeviceShapeProfile) => void;
  readonly resize: (width: number, height: number, pixelRatio: number) => void;
  readonly screenPoint: (
    x: number,
    y: number,
    captured?: boolean,
  ) => { x: number; y: number } | null;
  readonly orbit: (deltaX: number, deltaY: number) => void;
  readonly zoomBy: (logDelta: number) => void;
  readonly resetPose: () => void;
  readonly dispose: () => void;
}

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
  let imported: Awaited<ReturnType<typeof loadDeviceModel>> | null = null;
  let modelSource = options.model ?? null;
  let accessory: Awaited<ReturnType<typeof loadDeviceModel>> | null = null;
  let accessoryBounds: Box3 | null = null;
  let phone = createPhoneScene(texture, layout, profile);
  scene.add(phone.root);
  let disposed = false;
  const pose = createPhonePose();
  let viewport = { width: 0, height: 0, pixelRatio: 1 };
  let drawingBuffer = { width: 0, height: 0, pixelRatio: 0 };

  let framingAspect: number | null = null;
  const fit = () => {
    if (!viewport.width || !viewport.height) return;
    camera.aspect = viewport.width / viewport.height;
    const bounds = new Box3(
      new Vector3(-phone.width / 2, -phone.height / 2, 0),
      new Vector3(phone.width / 2, phone.height / 2, 0),
    );
    if (imported && accessoryBounds) bounds.union(accessoryBounds);
    bounds.applyMatrix4(new Matrix4().makeRotationZ(layout.rotation));
    const size = bounds.getSize(new Vector3());
    const aspect = size.x / size.y;
    if (aspect !== framingAspect) {
      framingAspect = aspect;
      options.onFramingAspect?.(aspect);
    }
    const center = bounds.getCenter(new Vector3());
    // Center the whole assembly without moving the device's canonical screen or its input plane.
    center.applyMatrix4(new Matrix4().makeRotationFromEuler(phone.root.rotation));
    const tangent = Math.tan((camera.fov * Math.PI) / 360);
    const distance =
      (Math.max(size.y / (2 * tangent), size.x / (2 * tangent * camera.aspect)) * 1.22 +
        size.z / 2 +
        0.18) /
      pose.zoom;
    camera.position.set(center.x, center.y, center.z + distance);
    camera.lookAt(center);
    camera.updateProjectionMatrix();
  };
  const applyPose = () => {
    phone.root.rotation.set(pose.pitch, pose.yaw, 0, "YXZ");
    phone.orientation.rotation.z = layout.rotation;
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
      applyPose();
      renderer.render(scene, camera);
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
      if (!imported && (nextProfile !== profile || next.aspect !== layout.aspect)) {
        scene.remove(phone.root);
        phone.dispose();
        phone = createPhoneScene(texture, next, nextProfile);
        scene.add(phone.root);
      } else {
        phone.setDisplay(texture, next);
      }
      layout = next;
      profile = nextProfile;
      fit();
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
          : createPhoneScene(texture, layout, profile);
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
      fit();
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
      fit();
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
      fit();
      scheduler.invalidate();
    },
    screenPoint(x, y, captured = false) {
      if (disposed) return null;
      applyPose();
      return phone.screenPoint(x, y, camera, captured);
    },
    orbit(deltaX, deltaY) {
      if (disposed) return;
      pose.orbit(deltaX, deltaY);
      if (accessory) {
        applyPose();
        fit();
      }
      scheduler.invalidate();
    },
    zoomBy(logDelta) {
      if (disposed) return;
      pose.zoomBy(logDelta);
      fit();
      scheduler.invalidate();
    },
    resetPose() {
      if (disposed) return;
      pose.reset();
      applyPose();
      fit();
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
