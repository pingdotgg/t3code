import type { PerspectiveCamera, Scene, Object3D } from "three";
import { afterEach, expect, it, vi } from "vite-plus/test";

const gpu = vi.hoisted(() => ({
  instances: [] as {
    blank: boolean;
    allocations: number;
    disposed: boolean;
    size: { width: number; height: number; pixelRatio: number };
    frames: {
      scene: Scene;
      phone: Object3D | undefined;
      rotation: Quaternion | undefined;
      displayAngle: number | undefined;
      yaw: number | undefined;
      cameraZ: number;
    }[];
  }[],
}));

vi.mock("three", async () => {
  const actual = await vi.importActual<typeof import("three")>("three");
  return {
    ...actual,
    WebGLRenderer: class {
      outputColorSpace = "";
      state: (typeof gpu.instances)[number] = {
        blank: true,
        allocations: 0,
        disposed: false,
        size: { width: 0, height: 0, pixelRatio: 1 },
        frames: [],
      };
      constructor() {
        gpu.instances.push(this.state);
      }
      setDrawingBufferSize(width: number, height: number, pixelRatio: number) {
        this.state.size = { width, height, pixelRatio };
        this.state.allocations++;
        this.state.blank = true;
      }
      setSize(width: number, height: number) {
        this.setDrawingBufferSize(width, height, this.state.size.pixelRatio);
      }
      setPixelRatio(pixelRatio: number) {
        this.setDrawingBufferSize(this.state.size.width, this.state.size.height, pixelRatio);
      }
      render(scene: Scene, camera: PerspectiveCamera) {
        const phone = scene.children.find((child) => child.type === "Group");
        this.state.frames.push({
          scene,
          phone,
          rotation: phone?.quaternion.clone(),
          displayAngle: phone?.children[0]?.rotation.z,
          yaw: phone?.rotation.y,
          cameraZ: camera.position.z,
        });
        this.state.blank = false;
      }
      dispose() {
        this.state.disposed = true;
      }
      forceContextLoss() {}
    },
  };
});

const models = vi.hoisted(() => ({
  pending: [] as {
    signal: AbortSignal;
    resolve: (model: { asset: import("three").Group; dispose: () => void }) => void;
  }[],
}));
vi.mock("./modelScene.ts", async () => {
  const actual = await vi.importActual<typeof import("./modelScene.ts")>("./modelScene.ts");
  return {
    ...actual,
    loadDeviceModel: (_source: unknown, signal: AbortSignal) =>
      new Promise((resolve) => models.pending.push({ signal, resolve })),
  };
});

import { BoxGeometry, Group, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion } from "three";
import { disposeDeviceModel } from "./modelScene.ts";
import { createPhoneViewer } from "./phoneViewer.ts";
import {
  ANDROID_PHONE_SHAPE,
  IOS_TABLET_SHAPE,
  resolveDeviceShape,
  type DeviceShapeProfile,
} from "./shapeProfile.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  gpu.instances.length = 0;
  models.pending.length = 0;
});

function fixture(profile?: DeviceShapeProfile) {
  const pending = new Map<number, FrameRequestCallback>();
  let id = 0;
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    pending.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => pending.delete(id));
  const canvas = Object.assign(new EventTarget(), { width: 0, height: 0 }) as HTMLCanvasElement;
  const source = { width: 1206, height: 2622 } as HTMLCanvasElement;
  const onUnavailable = vi.fn();
  const onFramingAspect = vi.fn();
  const viewer = createPhoneViewer({
    canvas,
    source,
    onUnavailable,
    onFramingAspect,
    ...(profile ? { profile } : {}),
  });
  const draw = (time = now) => {
    now = time;
    const callbacks = [...pending.values()];
    pending.clear();
    callbacks.forEach((callback) => callback(0));
  };
  viewer.resize(400, 700, 2);
  draw();
  return {
    viewer,
    draw,
    pending,
    source,
    onUnavailable,
    onFramingAspect,
    state: gpu.instances[0]!,
  };
}

it("retains the drawn phone until resize and redraw commit together, without replacing scene or pose", () => {
  const { viewer, draw, pending, source, state, onUnavailable } = fixture();
  viewer.orbit(0.08, 0.04);
  draw();
  const previous = state.frames.at(-1)!;
  const allocations = state.allocations;
  viewer.resize(500, 700, 2);
  viewer.resize(450, 700, 2);
  viewer.frameUpdated();
  // ResizeObserver runs after rAF. A cleared buffer here would reach the browser's next paint.
  expect(state.blank).toBe(false);
  expect(state.allocations).toBe(allocations);
  expect(pending.size).toBe(1);
  draw();
  expect(state.size).toEqual({ width: 450, height: 700, pixelRatio: 2 });
  expect(state.blank).toBe(false);
  expect(state.allocations).toBe(allocations + 1);
  expect(state.frames.at(-1)?.scene).toBe(previous.scene);
  expect(state.frames.at(-1)?.phone).toBe(previous.phone);
  expect(state.frames.at(-1)?.yaw).toBe(previous.yaw);
  viewer.resize(400, 700, 2);
  draw();
  expect(state.frames.at(-1)?.cameraZ).toBeCloseTo(previous.cameraZ);
  expect(source).toMatchObject({ width: 1206, height: 2622 });
  expect(gpu.instances).toHaveLength(1);
  expect(onUnavailable).not.toHaveBeenCalled();
  viewer.dispose();
});

it("ignores redundant and invalid sizes and combines a DPR change into one allocation and draw", () => {
  const { viewer, draw, pending, state } = fixture();
  const allocations = state.allocations;
  viewer.resize(400, 700, 2);
  viewer.resize(400, 700, 5);
  viewer.resize(0, 700, 2);
  viewer.resize(NaN, 700, 2);
  expect(pending.size).toBe(0);
  viewer.resize(400, 700, 1);
  expect(state.blank).toBe(false);
  draw();
  expect(state.size.pixelRatio).toBe(1);
  expect(state.allocations).toBe(allocations + 1);
  viewer.resize(450, 700, 1);
  viewer.dispose();
  draw();
  expect(state.allocations).toBe(allocations + 1);
  expect(state.disposed).toBe(true);
});

it("changes device shape without replacing the renderer, decoded source or pose", () => {
  const { viewer, draw, source, state } = fixture();
  viewer.orbit(0.1, 0.05);
  draw();
  const previous = state.frames.at(-1)!;
  const allocations = state.allocations;
  viewer.setScreen(null, IOS_TABLET_SHAPE);
  draw();
  expect(state.frames.at(-1)?.phone).not.toBe(previous.phone);
  expect(state.frames.at(-1)?.yaw).toBe(previous.yaw);
  expect(state.frames.at(-1)?.scene).toBe(previous.scene);
  expect(state.allocations).toBe(allocations);
  expect(source.width).toBe(1206);
  expect(gpu.instances).toHaveLength(1);
  const tablet = state.frames.at(-1)?.phone;
  viewer.frameUpdated();
  draw();
  expect(state.frames.at(-1)?.phone).toBe(tablet);
  viewer.dispose();
});

it("keeps the Android viewer while the resized framebuffer turns between fold postures", () => {
  const openProfile = resolveDeviceShape({ platform: "android", portraitAspect: 0.96 });
  const { viewer, draw, source, state } = fixture(openProfile);
  const scene = state.frames.at(-1)!.scene;
  source.width = 2076;
  source.height = 2152;
  viewer.setScreen({ width: 2076, height: 2152, orientation: "landscape_left" });
  viewer.frameUpdated();
  draw(0);
  expect(state.frames.at(-1)!.displayAngle).toBeCloseTo(0);
  draw(225);
  expect(state.frames.at(-1)!.displayAngle).toBeCloseTo(-Math.PI / 4);
  draw(450);
  expect(state.frames.at(-1)!.displayAngle).toBeCloseTo(-Math.PI / 2);
  expect(state.frames.at(-1)!.scene).toBe(scene);
  expect(gpu.instances).toHaveLength(1);

  source.width = 1080;
  source.height = 2424;
  viewer.setScreen({ width: 1080, height: 2424, orientation: "portrait" }, ANDROID_PHONE_SHAPE);
  viewer.frameUpdated();
  draw(450);
  expect(state.frames.at(-1)!.displayAngle).toBeCloseTo(-Math.PI / 2);
  draw(675);
  expect(state.frames.at(-1)!.displayAngle).toBeCloseTo(-Math.PI / 4);
  draw(900);
  expect(state.frames.at(-1)!.displayAngle).toBeCloseTo(0);
  expect(state.frames.at(-1)!.scene).toBe(scene);
  viewer.dispose();
});

it("animates the Android hinge on the same scene through an encoder resize", () => {
  const openProfile = resolveDeviceShape({ platform: "android", portraitAspect: 0.96 });
  const { viewer, draw, source, state } = fixture(openProfile);
  viewer.setFoldAngle(180);
  draw(0);
  const shell = state.frames.at(-1)!.phone!;
  const moving = shell.children[0]!.children[0]!;
  viewer.setFoldAngle(0);
  draw(425);
  expect(moving.rotation.y).toBeCloseTo(Math.PI / 2);
  source.width = 1080;
  source.height = 2424;
  viewer.setScreen({ width: 1080, height: 2424, orientation: "portrait" }, ANDROID_PHONE_SHAPE);
  viewer.frameUpdated();
  draw(850);
  expect(moving.rotation.y).toBeCloseTo(Math.PI);
  expect(state.frames.at(-1)!.phone).toBe(shell);
  expect(gpu.instances).toHaveLength(1);
  viewer.dispose();
});

it("retargets an unfinished hinge turn from its visible angle", () => {
  const { viewer, draw, state } = fixture(ANDROID_PHONE_SHAPE);
  viewer.setFoldAngle(180);
  draw(0);
  const moving = state.frames.at(-1)!.phone!.children[0]!.children[0]!;
  viewer.setFoldAngle(0);
  draw(200);
  const visibleAngle = moving.rotation.y;
  viewer.setFoldAngle(180);
  draw(200);
  expect(moving.rotation.y).toBeCloseTo(visibleAngle);
  draw(1050);
  expect(moving.rotation.y).toBeCloseTo(0);
  viewer.dispose();
});

it("stops a hinge turn when a loaded model replaces the fold scene", async () => {
  const { viewer, draw, pending } = fixture(ANDROID_PHONE_SHAPE);
  viewer.setFoldAngle(180);
  draw(0);
  viewer.setFoldAngle(0);
  viewer.setModel({ id: "iphone-18-pro", url: "/fold.glb" });
  const asset = new Group();
  const body = new Mesh(new BoxGeometry(1, 2, 0.1), new MeshBasicMaterial());
  const display = new Mesh(new PlaneGeometry(0.9, 1.9), new MeshBasicMaterial());
  display.name = "device-screen";
  asset.add(body, display);
  models.pending[0]!.resolve({ asset, dispose: () => disposeDeviceModel(asset) });
  await Promise.resolve();
  draw(200);
  draw(1050);
  expect(pending.size).toBe(0);
  viewer.dispose();
});

it("keeps a loaded model when the fold angle changes and releases it once", async () => {
  const { viewer, draw, state } = fixture(ANDROID_PHONE_SHAPE);
  viewer.setModel({ id: "iphone-18-pro", url: "/pro.glb" });
  const asset = new Group();
  const body = new Mesh(new BoxGeometry(1.15, 2.3, 0.1), new MeshBasicMaterial());
  body.position.z = -0.02;
  const display = new Mesh(new PlaneGeometry(1, 2.2), new MeshBasicMaterial());
  display.geometry.translate(0, 0, 0.043);
  display.name = "device-screen";
  asset.add(body, display);
  const dispose = vi.fn(() => disposeDeviceModel(asset));
  models.pending[0]!.resolve({ asset, dispose });
  await Promise.resolve();
  draw();
  const loaded = state.frames.at(-1)!.phone;
  expect(loaded?.getObjectByName("device-screen")).toBe(display);
  viewer.setFoldAngle(180);
  viewer.setFoldAngle(0);
  draw();
  expect(state.frames.at(-1)!.phone).toBe(loaded);
  viewer.dispose();
  expect(dispose).toHaveBeenCalledOnce();
});

it("retains the loaded model and pose through rotation and framebuffer resolution changes, then releases it once", async () => {
  const { viewer, draw, source, state } = fixture();
  viewer.orbit(0.08, 0.04);
  draw();
  const yaw = state.frames.at(-1)!.yaw;
  viewer.setModel({ id: "iphone-18-pro", url: "/pro.glb" });
  const asset = new Group();
  const body = new Mesh(new BoxGeometry(1.15, 2.3, 0.1), new MeshBasicMaterial());
  body.position.z = -0.02;
  const display = new Mesh(new PlaneGeometry(1, 2.2), new MeshBasicMaterial());
  display.geometry.translate(0, 0, 0.043);
  display.name = "device-screen";
  asset.add(body, display);
  const release = vi.spyOn(body.geometry, "dispose");
  const dispose = vi.fn(() => disposeDeviceModel(asset));
  models.pending[0]!.resolve({ asset, dispose });
  await Promise.resolve();
  draw();
  const loaded = state.frames.at(-1)!.phone;
  expect(loaded?.getObjectByName("device-screen")).toBe(display);
  expect(state.frames.at(-1)!.yaw).toBe(yaw);
  source.width = 2622;
  source.height = 1206;
  viewer.setScreen({ width: 2622, height: 1206, orientation: "landscape_left" });
  viewer.frameUpdated();
  viewer.resize(700, 400, 1);
  draw();
  expect(state.frames.at(-1)!.phone).toBe(loaded);
  expect(state.frames.at(-1)!.yaw).toBe(yaw);
  expect(display.material.map?.image).toBe(source);
  expect(release).not.toHaveBeenCalled();
  expect(gpu.instances).toHaveLength(1);
  viewer.dispose();
  viewer.dispose();
  expect(dispose).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
});

it("attaches and detaches an accessory without replacing the device, stream texture, renderer or pose", async () => {
  const { viewer, draw, source, state, onFramingAspect } = fixture();
  viewer.setModel({ id: "ipad-pro-13-m5", url: "/ipad.glb" });
  const asset = new Group();
  const body = new Mesh(new BoxGeometry(1.8, 2.3, 0.1), new MeshBasicMaterial());
  const display = new Mesh(new PlaneGeometry(1.7, 2.2), new MeshBasicMaterial());
  display.geometry.translate(0, 0, 0.043);
  display.name = "device-screen";
  asset.add(body, display);
  const releaseBody = vi.fn(() => disposeDeviceModel(asset));
  models.pending[0]!.resolve({ asset, dispose: releaseBody });
  await Promise.resolve();
  viewer.orbit(0.1, 0.05);
  draw();
  const before = state.frames.at(-1)!;
  const bareAspect = onFramingAspect.mock.lastCall![0];
  const keyboard = new Group();
  const deck = new Mesh(new BoxGeometry(2, 1, 1), new MeshBasicMaterial());
  deck.position.set(1, 0, 0.5);
  keyboard.add(deck);
  const releaseKeyboard = vi.fn(() => disposeDeviceModel(keyboard));
  viewer.setAccessory({
    id: "ipad-pro-13-m5-magic-keyboard",
    modelId: "ipad-pro-13-m5",
    url: "/keyboard.glb",
  });
  models.pending[1]!.resolve({ asset: keyboard, dispose: releaseKeyboard });
  await Promise.resolve();
  draw();
  expect(state.frames.at(-1)!.phone).toBe(before.phone);
  expect(keyboard.parent).toBe(asset.parent);
  expect(state.frames.at(-1)!.yaw).toBe(before.yaw);
  expect(display.material.map?.image).toBe(source);
  expect(state.frames.at(-1)!.cameraZ).toBeGreaterThan(before.cameraZ);
  expect(onFramingAspect.mock.lastCall![0]).toBeGreaterThan(bareAspect);
  const calls = onFramingAspect.mock.calls.length;
  viewer.orbit(0.1, 0.05);
  viewer.frameUpdated();
  draw();
  expect(onFramingAspect).toHaveBeenCalledTimes(calls);
  viewer.setAccessory(null);
  draw();
  expect(keyboard.parent).toBeNull();
  expect(onFramingAspect.mock.lastCall![0]).toBeCloseTo(bareAspect);
  expect(releaseKeyboard).toHaveBeenCalledOnce();
  expect(releaseBody).not.toHaveBeenCalled();
  expect(state.frames.at(-1)!.phone).toBe(before.phone);
  expect(state.frames.at(-1)!.cameraZ).toBeCloseTo(before.cameraZ);
  expect(gpu.instances).toHaveLength(1);
  viewer.dispose();
  expect(releaseBody).toHaveBeenCalledOnce();
  expect(releaseKeyboard).toHaveBeenCalledOnce();
});

it("rejects incompatible accessories and releases an accessory that finishes after detaching", async () => {
  const { viewer } = fixture();
  const keyboard = {
    id: "ipad-pro-13-m5-magic-keyboard",
    modelId: "ipad-pro-13-m5",
    url: "/keyboard.glb",
  } as const;
  viewer.setAccessory(keyboard);
  expect(models.pending).toHaveLength(0);
  viewer.setModel({ id: "ipad-pro-13-m5", url: "/ipad.glb" });
  viewer.setAccessory(keyboard);
  viewer.setAccessory(null);
  expect(models.pending[1]!.signal.aborted).toBe(true);
  const dispose = vi.fn();
  const asset = new Group();
  models.pending[1]!.resolve({ asset, dispose });
  await Promise.resolve();
  expect(asset.parent).toBeNull();
  expect(dispose).toHaveBeenCalledOnce();
  viewer.dispose();
});

it("springs an ordinary device back toward its screen, freezes captured input, and stops rendering at rest", () => {
  const { viewer, draw, pending, state } = fixture();
  const initialYaw = state.frames.at(-1)!.yaw!;
  viewer.setInteractionActive(true, "orbit");
  viewer.orbit(0.8, 0.4);
  draw(80);
  const dragged = state.frames.at(-1)!;
  expect(Math.abs(dragged.yaw! - initialYaw)).toBeGreaterThan(0.05);
  viewer.setInteractionActive(false, "orbit");
  draw(160);
  viewer.setInteractionActive(true, "touch");
  draw(180);
  const captured = state.frames.at(-1)!;
  viewer.orbit(1, 1);
  viewer.frameUpdated();
  draw(1000);
  expect(state.frames.at(-1)!.yaw).toBe(captured.yaw);
  expect(state.frames.at(-1)!.cameraZ).toBe(captured.cameraZ);
  expect(pending.size).toBe(0);
  viewer.setInteractionActive(false, "touch");
  for (let time = 1016; time <= 4000 && pending.size; time += 16) draw(time);
  expect(pending.size).toBe(0);
  expect(Math.abs(state.frames.at(-1)!.yaw!)).toBeLessThanOrEqual(Math.PI / 3 + 1e-6);
  expect(state.frames.at(-1)!.phone).toBe(dragged.phone);
  viewer.dispose();
});

it("resets the device to a square front view after orbiting", () => {
  const { viewer, draw, pending, state } = fixture();
  const front = state.frames.at(-1)!.rotation!;
  expect(front.angleTo(new Quaternion())).toBeLessThan(1e-6);
  viewer.orbit(0.8, 0.4);
  draw(80);
  expect(state.frames.at(-1)!.rotation!.angleTo(front)).toBeGreaterThan(0.05);
  viewer.resetPose();
  for (let time = 96; time <= 3000 && pending.size; time += 16) draw(time);
  expect(pending.size).toBe(0);
  expect(state.frames.at(-1)!.rotation!.angleTo(new Quaternion())).toBeLessThan(1e-6);
  viewer.dispose();
});
