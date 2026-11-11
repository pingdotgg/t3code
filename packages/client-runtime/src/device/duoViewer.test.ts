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
import { Group, Mesh, MeshBasicMaterial, PlaneGeometry } from "three";
import { createDuoViewer } from "./duoViewer.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  gpu.instances.length = 0;
  gpu.environmentDispose.mockClear();
});

function fixture(
  reduced = true,
  onOrientationRequested = vi.fn(),
  onPanelRequested?: (panel: 1 | 3) => void,
) {
  const pending = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    pending.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => pending.delete(id));
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  const drawImage = vi.fn();
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
        drawImage,
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
    ...(onPanelRequested ? { onPanelRequested } : {}),
  });
  const draw = () => {
    const callbacks = [...pending.values()];
    pending.clear();
    callbacks.forEach((callback) => callback(0));
  };
  return { viewer, draw, pending, state: gpu.instances[0]!, onOrientationRequested, drawImage };
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

it("uses the elected primary frame during handoff and never lets a stale fixed-panel feed overwrite it", async () => {
  const { viewer, drawImage } = fixture();
  const cover = {
    width: 1398,
    height: 2034,
    orientation: "portrait" as const,
    screenId: 1,
    hingeAngle: 90,
  };
  viewer.setScreen(cover);
  const primary = { width: 1398, height: 2034 } as HTMLCanvasElement;
  viewer.frameUpdated(1, primary);
  expect(drawImage.mock.calls.at(-1)?.[0]).toBe(primary);
  const uploads = drawImage.mock.calls.length;
  viewer.frameUpdated(1);
  expect(drawImage).toHaveBeenCalledTimes(uploads);
  viewer.frameUpdated(3, primary);
  expect(drawImage).toHaveBeenCalledTimes(uploads);
  viewer.setScreen({ ...cover, width: 2007, height: 2853, screenId: 3 });
  const inner = { width: 2007, height: 2853 } as HTMLCanvasElement;
  viewer.frameUpdated(3, inner);
  expect(drawImage.mock.calls.at(-1)?.[0]).toBe(inner);
  viewer.setScreen(cover);
  viewer.frameUpdated(1);
  expect(drawImage.mock.calls.length).toBeGreaterThan(uploads + 1);
  viewer.dispose();
});
