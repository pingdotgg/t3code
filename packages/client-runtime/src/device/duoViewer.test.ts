import { afterEach, expect, it, vi } from "vite-plus/test";
import type { Scene, PerspectiveCamera, Box3, Quaternion } from "three";

const gpu = vi.hoisted(() => ({
  instances: [] as {
    blank: boolean;
    allocations: number;
    frames: Scene[];
    views: { camera: PerspectiveCamera; bounds: Box3; quaternion: Quaternion }[];
    dispose: ReturnType<typeof vi.fn>;
    forceContextLoss: ReturnType<typeof vi.fn>;
  }[],
  environmentDispose: vi.fn(),
}));
vi.mock("three", async () => {
  const actual = await vi.importActual<typeof import("three")>("three");
  return {
    ...actual,
    WebGLRenderer: class {
      state = {
        blank: true,
        allocations: 0,
        frames: [] as Scene[],
        views: [] as { camera: PerspectiveCamera; bounds: Box3; quaternion: Quaternion }[],
        dispose: vi.fn(),
        forceContextLoss: vi.fn(),
      };
      constructor() {
        gpu.instances.push(this.state);
      }
      setDrawingBufferSize() {
        this.state.blank = true;
        this.state.allocations++;
      }
      render(scene: Scene, camera: PerspectiveCamera) {
        this.state.blank = false;
        this.state.frames.push(scene);
        const root = scene.children.find((child) => child instanceof actual.Group)!;
        root.updateMatrixWorld(true);
        camera.updateMatrixWorld(true);
        this.state.views.push({
          camera: camera.clone(),
          bounds: new actual.Box3().setFromObject(root),
          quaternion: root.quaternion.clone(),
        });
      }
      dispose() {
        this.state.dispose();
      }
      forceContextLoss() {
        this.state.forceContextLoss();
      }
    },
    PMREMGenerator: class {
      fromScene() {
        return { texture: new actual.Texture(), dispose: gpu.environmentDispose };
      }
      dispose() {}
    },
  };
});
const models = vi.hoisted(() => ({
  resolve: (_model: { asset: import("three").Group; dispose: () => void }) => {},
  signal: null as AbortSignal | null,
}));
vi.mock("./modelScene.ts", () => ({
  loadDeviceModel: (_source: unknown, signal: AbortSignal) => {
    models.signal = signal;
    return new Promise((resolve) => {
      models.resolve = resolve;
    });
  },
}));
import {
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
  Euler,
  Quaternion as Rotation,
} from "three";
import { createDuoViewer } from "./duoViewer.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  gpu.instances.length = 0;
  gpu.environmentDispose.mockClear();
});

function fixture(reduced = true, onOrientationRequested = vi.fn()) {
  const pending = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    pending.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => pending.delete(id));
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        fillRect() {},
        save() {},
        restore() {},
        translate() {},
        rotate() {},
        drawImage() {},
        getImageData: () => ({ data: new Uint8ClampedArray(8 * 8 * 4).fill(255) }),
      }),
    }),
  });
  const canvas = new EventTarget() as HTMLCanvasElement;
  const viewer = createDuoViewer({
    canvas,
    sources: {
      1: { width: 1398, height: 2034 } as HTMLCanvasElement,
      3: { width: 2007, height: 2853 } as HTMLCanvasElement,
    },
    model: { id: "iphone-duo", url: "/duo.glb" },
    onUnavailable: vi.fn(),
    onOrientationRequested,
  });
  const draw = () => {
    const callbacks = [...pending.values()];
    pending.clear();
    callbacks.forEach((callback) => callback(0));
  };
  return { viewer, draw, pending, state: gpu.instances[0]!, onOrientationRequested };
}

function asset() {
  const group = new Group();
  for (const [name, names] of [
    ["left-half", ["cover-display", "inner-display-left"]],
    ["right-half", ["inner-display-right"]],
  ] as const) {
    const leaf = new Group();
    leaf.name = name;
    for (const name of names) {
      const mesh = new Mesh(new PlaneGeometry(1, 2), new MeshBasicMaterial());
      if (name === "cover-display") mesh.geometry.rotateY(Math.PI);
      mesh.geometry.translate(
        name === "inner-display-right" ? 0.5 : -0.5,
        0,
        name === "cover-display" ? -0.05 : 0.05,
      );
      mesh.name = name;
      leaf.add(mesh);
    }
    group.add(leaf);
  }
  return group;
}

it("coalesces resize with redraw, retains the renderer and scene, and settles without an idle animation loop", async () => {
  let now = 0;
  vi.stubGlobal("performance", { now: () => now });
  const { viewer, draw, pending, state } = fixture();
  const dispose = vi.fn();
  models.resolve({ asset: asset(), dispose });
  await Promise.resolve();
  viewer.setScreen({
    width: 1398,
    height: 2034,
    orientation: "portrait",
    screenId: 1,
    hingeAngle: 0,
  });
  viewer.resize(500, 700, 2);
  draw();
  const scene = state.frames.at(-1);
  viewer.resize(450, 700, 2);
  viewer.resize(400, 700, 2);
  viewer.orbit(0.1, 0.04);
  expect(state.blank).toBe(false);
  expect(state.allocations).toBe(1);
  expect(pending.size).toBe(1);
  draw();
  expect(state.blank).toBe(false);
  expect(state.allocations).toBe(2);
  expect(state.frames.at(-1)).toBe(scene);
  expect(gpu.instances).toHaveLength(1);
  now += 1000;
  draw();
  draw();
  expect(pending.size).toBe(0);
  viewer.dispose();
  viewer.dispose();
  expect(dispose).toHaveBeenCalledOnce();
  expect(state.dispose).toHaveBeenCalledOnce();
  expect(gpu.environmentDispose).toHaveBeenCalledOnce();
  expect(pending.size).toBe(0);
});

it("cancels loading and disposes a late model after unmount without installing or rendering it", async () => {
  const { viewer, draw, state } = fixture();
  viewer.resize(400, 700, 2);
  viewer.dispose();
  expect(models.signal?.aborted).toBe(true);
  const dispose = vi.fn();
  models.resolve({ asset: asset(), dispose });
  await Promise.resolve();
  draw();
  expect(dispose).toHaveBeenCalledOnce();
  expect(state.frames).toHaveLength(0);
});

it("keeps the chosen release view when an app locks orientation, freezes it during contact, and stops drawing after release", async () => {
  let now = 0;
  vi.stubGlobal("performance", { now: () => now });
  const { viewer, draw, state, pending, onOrientationRequested } = fixture();
  models.resolve({ asset: asset(), dispose: vi.fn() });
  await Promise.resolve();
  const screen = {
    width: 1398,
    height: 2034,
    orientation: "portrait" as const,
    screenId: 1,
    hingeAngle: 0,
  };
  viewer.setScreen(screen);
  viewer.resize(500, 700, 2);
  draw();
  const initial = state.views.at(-1)!.quaternion.clone();
  viewer.setInteractionActive(true);
  viewer.orbit(0, Math.PI / 3);
  draw();
  const held = state.views.at(-1)!.quaternion.clone();
  now = 1000;
  viewer.frameUpdated(1);
  draw();
  expect(state.views.at(-1)!.quaternion.angleTo(held)).toBeLessThan(1e-6);
  expect(onOrientationRequested).not.toHaveBeenCalled();
  viewer.setInteractionActive(false);
  draw();
  expect(onOrientationRequested).toHaveBeenCalledOnce();
  const chosen = state.views.at(-1)!.quaternion.clone();
  expect(chosen.angleTo(initial)).toBeGreaterThan(1);
  viewer.setScreen({ ...screen }); // Native config confirms the sensor command, even if the app stays portrait.
  draw();
  expect(state.views.at(-1)!.quaternion.angleTo(chosen)).toBeLessThan(1e-6);
  expect(pending.size).toBe(0);
  viewer.resetPose();
  draw();
  expect(onOrientationRequested).toHaveBeenCalledTimes(2);
  expect(onOrientationRequested.mock.lastCall?.[0]).toBe("portrait");
  viewer.setScreen({ ...screen });
  draw();
  expect(pending.size).toBe(0);
  viewer.dispose();
});

it("settles a hinge transition after a throttled frame instead of stretching time", async () => {
  let now = 100;
  vi.stubGlobal("performance", { now: () => now });
  const { viewer, draw, pending } = fixture(false);
  models.resolve({ asset: asset(), dispose: vi.fn() });
  await Promise.resolve();
  viewer.resize(400, 700, 2);
  viewer.setScreen({
    width: 1398,
    height: 2034,
    orientation: "portrait",
    screenId: 1,
    hingeAngle: 0,
  });
  draw();
  viewer.setScreen({
    width: 2007,
    height: 2853,
    orientation: "portrait",
    screenId: 3,
    hingeAngle: 180,
  });
  now += 1_000;
  draw();
  draw();
  expect(pending.size).toBe(0);
  viewer.dispose();
});

it("faces a display handed off by native rotation without requesting another sensor rotation", async () => {
  let now = 0;
  vi.stubGlobal("performance", { now: () => now });
  const { viewer, draw, pending, onOrientationRequested } = fixture();
  const loaded = asset();
  models.resolve({ asset: loaded, dispose: vi.fn() });
  await Promise.resolve();
  viewer.resize(500, 700, 2);
  viewer.setScreen({
    width: 2007,
    height: 2853,
    orientation: "portrait",
    screenId: 3,
    hingeAngle: 90,
  });
  draw();
  viewer.orbit(0, Math.PI / 3);
  now = 1000;
  draw();
  const requests = onOrientationRequested.mock.calls.length;
  expect(requests).toBe(1);
  viewer.setScreen({
    width: 1398,
    height: 2034,
    orientation: "landscape_left",
    screenId: 1,
    hingeAngle: 90,
  });
  draw();
  draw();
  const cover = loaded.getObjectByName("cover-display") as Mesh;
  const normal = new Vector3()
    .fromBufferAttribute(cover.geometry.getAttribute("normal"), 0)
    .transformDirection(cover.matrixWorld);
  expect(normal.z).toBeGreaterThan(0.45);
  expect(onOrientationRequested).toHaveBeenCalledTimes(requests);
  expect(pending.size).toBe(0);
  viewer.dispose();
});

it.each(["book", "laptop", "open"] as const)(
  "faces native cover readback for %s even when configuration arrives before the model",
  async (hingePose) => {
    const { viewer, draw } = fixture();
    viewer.resize(500, 700, 2);
    viewer.setScreen({
      width: 1398,
      height: 2034,
      orientation: "landscape_left",
      screenId: 1,
      hingeAngle: hingePose === "open" ? 180 : 90,
      hingePose,
    });
    const loaded = asset();
    models.resolve({ asset: loaded, dispose: vi.fn() });
    await Promise.resolve();
    draw();
    draw();
    const cover = loaded.getObjectByName("cover-display") as Mesh;
    const normal = new Vector3()
      .fromBufferAttribute(cover.geometry.getAttribute("normal"), 0)
      .transformDirection(cover.matrixWorld);
    expect(normal.z).toBeGreaterThan(0.45);
    viewer.dispose();
  },
);

it("keeps every default-zoom orbit centered and inside a fixed camera frame across folds", async () => {
  const { viewer, draw, state } = fixture();
  models.resolve({ asset: asset(), dispose: vi.fn() });
  await Promise.resolve();
  viewer.resize(380, 620, 2);
  viewer.resetPose();
  viewer.setInteractionActive(true);
  let distance = 0;
  for (const hingeAngle of [0, 30, 90, 127, 180]) {
    viewer.setScreen({
      width: 2007,
      height: 2853,
      orientation: "portrait",
      screenId: 3,
      hingeAngle,
    });
    for (let turn = 0; turn < 16; turn++) {
      viewer.orbit(0.1, turn % 2 ? -0.08 : 0.08);
      draw();
      const { camera, bounds } = state.views.at(-1)!;
      const center = bounds.getCenter(new Vector3()).project(camera);
      expect(Math.abs(center.x)).toBeLessThan(0.18);
      expect(Math.abs(center.y)).toBeLessThan(0.18);
      state.frames.at(-1)!.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        const positions = object.geometry.getAttribute("position");
        for (let index = 0; index < positions.count; index++) {
          const point = new Vector3()
            .fromBufferAttribute(positions, index)
            .applyMatrix4(object.matrixWorld)
            .project(camera);
          expect(Math.abs(point.x)).toBeLessThan(1);
          expect(Math.abs(point.y)).toBeLessThan(1);
        }
      });
      if (distance) expect(camera.position.z).toBe(distance);
      distance = camera.position.z;
    }
  }
  viewer.dispose();
});

it("previews slider articulation immediately without changing laptop presentation or accepting unconfirmed input", async () => {
  const { viewer, draw, state, pending } = fixture();
  const loaded = asset();
  models.resolve({ asset: loaded, dispose: vi.fn() });
  await Promise.resolve();
  viewer.resize(500, 700, 2);
  viewer.setScreen({
    width: 2853,
    height: 2007,
    orientation: "landscape_left",
    screenId: 3,
    hingeAngle: 90,
    hingePose: "laptop",
  });
  draw();
  const presentation = state.views.at(-1)!.quaternion;
  for (const value of [127, 50, 170]) {
    viewer.setHingePreview(value);
    draw();
    expect(loaded.getObjectByName("left-half")!.rotation.y).toBeCloseTo(
      ((180 - value) * Math.PI) / 360,
    );
    expect(state.views.at(-1)!.quaternion.angleTo(presentation)).toBeLessThan(0.00001);
    expect(viewer.screenPoint(0.5, 0.5)).toBeNull();
    viewer.setScreen({
      width: 2007,
      height: 2853,
      orientation: "portrait",
      screenId: 3,
      hingeAngle: value,
      hingePose: null,
    });
    draw();
    expect(state.views.at(-1)!.quaternion.angleTo(presentation)).toBeLessThan(0.00001);
  }
  viewer.setHingePreview(null);
  draw();
  expect(pending.size).toBe(0);
  expect(state.views.at(-1)!.quaternion.angleTo(presentation)).toBeLessThan(0.00001);
  viewer.dispose();
});

it("does not restart an animated preset on duplicate native configurations", async () => {
  let now = 100;
  vi.stubGlobal("performance", { now: () => now });
  const { viewer, draw, pending } = fixture(false);
  models.resolve({ asset: asset(), dispose: vi.fn() });
  await Promise.resolve();
  viewer.resize(400, 700, 2);
  viewer.setScreen({
    width: 1398,
    height: 2034,
    orientation: "portrait",
    screenId: 1,
    hingeAngle: 0,
    hingePose: "closed",
  });
  draw();
  const next = {
    width: 2007,
    height: 2853,
    orientation: "portrait" as const,
    screenId: 3,
    hingeAngle: 180,
    hingePose: "open" as const,
  };
  viewer.setScreen(next);
  now += 1_000;
  viewer.setScreen(next);
  draw();
  now += 1000;
  draw();
  draw();
  expect(pending.size).toBe(0);
  viewer.dispose();
});

it("lets standalone rotation leave Laptop and Tent and stand a closed device upright after slider edits", async () => {
  const { viewer, draw, state } = fixture();
  models.resolve({ asset: asset(), dispose: vi.fn() });
  await Promise.resolve();
  viewer.resize(500, 700, 2);
  viewer.resetPose();
  for (const hingePose of ["laptop", "tent"] as const) {
    viewer.setScreen({
      width: 1398,
      height: 2034,
      orientation: "landscape_left",
      screenId: 1,
      hingeAngle: 90,
      hingePose,
    });
    draw();
    viewer.setHingePreview(0);
    viewer.setScreen({
      width: 1398,
      height: 2034,
      orientation: "landscape_left",
      screenId: 1,
      hingeAngle: 0,
      hingePose: null,
    });
    viewer.setHingePreview(null);
    draw();
    viewer.setScreen({
      width: 1398,
      height: 2034,
      orientation: "portrait",
      screenId: 1,
      hingeAngle: 0,
      hingePose: null,
    });
    draw();
    const upright = new Rotation().setFromEuler(new Euler(0, Math.PI / 2, 0, "YXZ"));
    expect(state.views.at(-1)!.quaternion.angleTo(upright)).toBeLessThan(0.00001);
    const bounds = state.views.at(-1)!.bounds;
    expect(bounds.max.y - bounds.min.y).toBeGreaterThan(bounds.max.x - bounds.min.x);
  }
  viewer.dispose();
});
