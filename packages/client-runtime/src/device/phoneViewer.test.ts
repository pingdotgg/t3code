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

import { Group, Quaternion } from "three";
import { createPhoneViewer } from "./phoneViewer.ts";
import { type DeviceShapeProfile } from "./shapeProfile.ts";

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
