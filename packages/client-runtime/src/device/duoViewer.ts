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
import { createPhonePose } from "./phonePose.ts";
import { createRenderScheduler } from "./renderScheduler.ts";
import type { DeviceScreenSize } from "./stream.ts";

export interface DuoViewer {
  readonly setScreen: (screen: DeviceScreenSize | null) => void;
  readonly frameUpdated: (panel: DuoPanelId) => void;
  readonly resize: (width: number, height: number, pixelRatio: number) => void;
  readonly screenPoint: (
    x: number,
    y: number,
    captured?: boolean,
  ) => { x: number; y: number } | null;
  readonly orbit: (x: number, y: number) => void;
  readonly zoomBy: (delta: number) => void;
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
  onFramingAspect?: (aspect: number) => void;
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
  let activationAt = 0;
  let disposed = false;
  let viewport = { width: 0, height: 0, ratio: 1 };
  let buffer = { width: 0, height: 0, ratio: 0 };
  const orbit = createPhonePose();
  let angle = 180;
  let targetAngle = 180;
  let firstPose = true;
  let presentation = new Quaternion();
  let targetPresentation = new Quaternion();
  let lastTime = 0;
  const reduced =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const applyPose = () => {
    if (!model) return;
    model.setAngle(angle);
    model.root.quaternion.copy(presentation);
    model.root.quaternion.premultiply(
      new Quaternion().setFromEuler(new Euler(orbit.pitch, orbit.yaw, 0, "YXZ")),
    );
  };
  let framingAspect = 0;
  const fit = () => {
    if (!model || !viewport.width || !viewport.height) return;
    camera.aspect = viewport.width / viewport.height;
    const bounds = new Box3().setFromObject(model.root);
    const size = bounds.getSize(new Vector3());
    const center = bounds.getCenter(new Vector3());
    const tangent = Math.tan((camera.fov * Math.PI) / 360);
    const distance =
      (Math.max(size.y / (2 * tangent), size.x / (2 * tangent * camera.aspect)) * 1.16 +
        size.z / 2) /
      orbit.zoom;
    camera.position.set(center.x, center.y, center.z + Math.max(1, distance));
    camera.lookAt(center);
    camera.updateProjectionMatrix();
  };
  const moving = () =>
    Math.abs(angle - targetAngle) > 0.01 || presentation.angleTo(targetPresentation) > 0.001;
  const scheduler = createRenderScheduler(() => {
    if (disposed || !model || !viewport.width || !viewport.height) return;
    try {
      const now = performance.now();
      const amount = reduced
        ? 1
        : 1 - Math.exp(-14 * Math.max(0, (now - lastTime) / 1000 || 0.016));
      lastTime = now;
      const inMotion = moving();
      if (inMotion) {
        angle += (targetAngle - angle) * amount;
        presentation.slerp(targetPresentation, amount);
        if (
          Math.abs(angle - targetAngle) <= 0.01 &&
          presentation.angleTo(targetPresentation) <= 0.001
        ) {
          angle = targetAngle;
          presentation.copy(targetPresentation);
        }
        applyPose();
        fit();
      }
      if (
        buffer.width !== viewport.width ||
        buffer.height !== viewport.height ||
        buffer.ratio !== viewport.ratio
      ) {
        renderer.setDrawingBufferSize(viewport.width, viewport.height, viewport.ratio);
        buffer = viewport;
      }
      renderer.render(scene, camera);
      if (inMotion) scheduler.invalidate();
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
      if (duoDisplayKey(screen) !== duoDisplayKey(next)) {
        readyKey = "";
        activationAt = performance.now();
        model?.cancelInput();
      }
      screen = next;
      const aspect =
        next?.screenId === 1
          ? 784 / 1140
          : next?.hingePose === "laptop" || next?.orientation === "portrait"
            ? 1125 / 1600
            : 1600 / 1125;
      if (aspect !== framingAspect) {
        framingAspect = aspect;
        options.onFramingAspect?.(aspect);
      }
      // A command reply/config confirms hinge state. Display identity, never an angle heuristic, owns input.
      targetAngle = next?.hingeAngle ?? (next?.screenId === 1 ? 0 : 180);
      const fold = ((180 - targetAngle) * Math.PI) / 360;
      let roll = next?.screenId === 3 ? Math.PI / 2 : 0;
      if (next && next.width < next.height) {
        if (next.orientation === "landscape_left") roll -= Math.PI / 2;
        if (next.orientation === "landscape_right") roll += Math.PI / 2;
      }
      if (next?.orientation === "portrait_upside_down") roll -= Math.PI;
      const physical =
        next?.hingePose === "laptop"
          ? new Euler(-fold + Math.PI / 9, -Math.PI / 9, Math.PI / 2, "YXZ")
          : next?.hingePose === "tent"
            ? new Euler(Math.PI / 2 + Math.PI / 18, -Math.PI / 9, -Math.PI / 2, "YXZ")
            : new Euler(0, (Math.PI / 2) * Math.pow(1 - targetAngle / 180, 3), 0, "YXZ");
      targetPresentation = new Quaternion().setFromEuler(physical);
      if (next?.hingePose !== "laptop" && next?.hingePose !== "tent")
        targetPresentation.premultiply(
          new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), roll),
        );
      if (firstPose) {
        firstPose = false;
        angle = targetAngle;
        presentation.copy(targetPresentation);
      }
      lastTime = performance.now();
      applyPose();
      fit();
      scheduler.invalidate();
    },
    frameUpdated(id) {
      if (disposed || screen?.screenId !== id) return;
      const source = options.sources[id];
      if (!duoFrameMatches(source, screen)) return;
      const surface = surfaces[id === 1 ? 0 : 1]!;
      const { context, canvas } = surface;
      // Ignore native shutdown blanks only while waiting for an activation. Steady black application content remains valid.
      if (!readyKey && performance.now() - activationAt < 1500) {
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
      scheduler.invalidate();
    },
    resize(width, height, ratio) {
      if (disposed || ![width, height, ratio].every(Number.isFinite) || width <= 0 || height <= 0)
        return;
      viewport = { width, height, ratio: Math.min(2, Math.max(1, ratio)) };
      fit();
      scheduler.invalidate();
    },
    screenPoint(x, y, captured = false) {
      if (disposed || moving()) return null;
      applyPose();
      return model?.screenPoint(x, y, camera, screen, readyKey, captured) ?? null;
    },
    cancelInput() {
      model?.cancelInput();
    },
    orbit(x, y) {
      orbit.orbit(x, y);
      applyPose();
      scheduler.invalidate();
    },
    zoomBy(delta) {
      orbit.zoomBy(delta);
      fit();
      scheduler.invalidate();
    },
    resetPose() {
      orbit.reset();
      applyPose();
      fit();
      scheduler.invalidate();
    },
    dispose() {
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
