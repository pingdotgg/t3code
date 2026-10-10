import { BoxGeometry, Mesh, MeshPhongMaterial, Texture } from "three";
import { act, StrictMode, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  parse: vi.fn(),
  renderers: [] as Array<{
    render: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    forceContextLoss: ReturnType<typeof vi.fn>;
    domElement: EventTarget & { remove: () => void };
  }>,
  managers: [] as Array<import("three").LoadingManager>,
  canvases: new Set<EventTarget>(),
}));

vi.mock("three", async (importOriginal) => {
  const original = await importOriginal<typeof import("three")>();
  return {
    ...original,
    WebGLRenderer: class {
      domElement = Object.assign(new EventTarget(), {
        className: "",
        remove: () => mocks.canvases.delete(this.domElement),
      });
      render = vi.fn();
      dispose = vi.fn();
      forceContextLoss = vi.fn();
      setPixelRatio = vi.fn();
      setSize = vi.fn();
      constructor() {
        mocks.renderers.push(this);
      }
    },
  };
});
vi.mock("./loadModel", () => ({
  parseModelInWorker: async () => mocks.parse(),
}));
vi.mock("./modelTransfer", () => ({
  restoreModel: (model: import("three").Object3D) => ({
    model,
    loadTextures: (manager: import("three").LoadingManager) => mocks.managers.push(manager),
  }),
}));
vi.mock("three/addons/controls/OrbitControls.js", () => ({
  OrbitControls: class {
    target = { set: vi.fn() };
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    dispose = vi.fn();
    update = vi.fn();
  },
}));
vi.mock("~/components/ui/spinner", () => ({ Spinner: () => null }));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipPopup: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

import { ModelPreview } from "./ModelPreview";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let surface: ReactTestRenderer | null;
const fetchFile = vi.fn<typeof fetch>();
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const viewport = {
  appendChild: (canvas: EventTarget) => mocks.canvases.add(canvas),
  getBoundingClientRect: () => ({ width: 400, height: 700 }),
};
const observers: Array<{ disconnected: boolean; callback: () => void }> = [];
const src = "https://host.test/api/assets/token/tree.fbx";
const response = () => new Response(new Uint8Array([1, 2, 3]));
const createModel = () => new Mesh(new BoxGeometry(), new MeshPhongMaterial());

async function mount(url = src, strict = false) {
  await act(async () => {
    const preview = <ModelPreview src={url} name="tree.fbx" />;
    surface = create(strict ? <StrictMode>{preview}</StrictMode> : preview, {
      createNodeMock: (element) => (element.type === "div" ? viewport : null),
    });
  });
}

async function switchFile(url: string) {
  await act(async () => {
    surface!.update(<ModelPreview src={url} name="model.fbx" />);
  });
}

function flushFrames() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}

function text() {
  return JSON.stringify(surface!.toJSON());
}

beforeEach(() => {
  surface = null;
  mocks.renderers.length = 0;
  mocks.managers.length = 0;
  mocks.canvases.clear();
  mocks.parse.mockReset().mockImplementation(createModel);
  frames.clear();
  observers.length = 0;
  fetchFile.mockReset().mockImplementation(async () => response());
  vi.stubGlobal("fetch", fetchFile);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { devicePixelRatio: 2 });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnected = false;
      constructor(readonly callback: () => void) {
        observers.push(this);
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    },
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => {
    surface?.unmount();
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("model viewer lifecycle", () => {
  it("shows missing-material warnings without hiding loaded geometry", async () => {
    const model = Object.assign(createModel(), {
      warnings: ["Material library missing: colors.mtl. Showing available materials."],
    });
    mocks.parse.mockReturnValueOnce(model);
    await mount();
    expect(text()).toContain("Material library missing: colors.mtl");
    expect(mocks.canvases.size).toBe(1);
    expect(surface!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  });
  it("keeps one live viewer after StrictMode replays setup and cleanup", async () => {
    await mount(src, true);
    expect(fetchFile.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(mocks.parse).toHaveBeenCalledTimes(1);
    expect(mocks.canvases.size).toBe(1);
    await act(async () => {
      surface!.unmount();
    });
    surface = null;
    expect(mocks.canvases.size).toBe(0);
    expect(mocks.renderers[0]!.forceContextLoss).toHaveBeenCalledTimes(1);
  });

  it("aborts retired fetches and never parses their late responses", async () => {
    const pending = deferred<Response>();
    fetchFile.mockImplementationOnce(() => pending.promise);
    await mount();
    const signal = fetchFile.mock.calls[0]![1]!.signal!;
    await switchFile(`${src}?other-file=1`);
    expect(signal.aborted).toBe(true);
    await act(async () => {
      pending.resolve(response());
    });
    expect(mocks.parse).toHaveBeenCalledTimes(1);
    expect(mocks.canvases.size).toBe(1);
  });

  it("resets the loading and error UI when changing files", async () => {
    fetchFile.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    await mount();
    expect(text()).toContain("Could not load this model (404)");
    const pending = deferred<Response>();
    fetchFile.mockImplementationOnce(() => pending.promise);
    await switchFile(`${src}?next=1`);
    expect(text()).toContain("Loading model");
    expect(text()).not.toContain("(404)");
    await act(async () => {
      pending.resolve(response());
    });
    expect(text()).not.toContain("Loading model");
  });

  it("releases contexts and canvases across 60 loaded model switches", async () => {
    await mount();
    for (let index = 1; index < 60; index++) {
      await switchFile(`${src}?model=${index}`);
      expect(mocks.canvases.size).toBe(1);
    }
    await act(async () => {
      surface!.unmount();
    });
    surface = null;
    expect(mocks.renderers).toHaveLength(60);
    for (const renderer of mocks.renderers) {
      expect(renderer.dispose).toHaveBeenCalledTimes(1);
      expect(renderer.forceContextLoss).toHaveBeenCalledTimes(1);
    }
    expect(mocks.canvases.size).toBe(0);
    expect(frames.size).toBe(0);
    expect(observers.every((observer) => observer.disconnected)).toBe(true);
  });

  it("coalesces redraws and does not run an idle render loop", async () => {
    await mount();
    const renderer = mocks.renderers[0]!;
    const manager = mocks.managers[0]!;
    observers[0]!.callback();
    manager.onLoad();
    manager.onLoad();
    expect(frames.size).toBe(1);
    flushFrames();
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    await act(async () => {
      surface!.unmount();
    });
    surface = null;
    manager.onLoad();
    observers[0]!.callback();
    flushFrames();
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it("keeps the model visible and names missing textures", async () => {
    const material = new MeshPhongMaterial({ map: new Texture() });
    mocks.parse.mockImplementation(() => new Mesh(new BoxGeometry(), material));
    await mount();
    const manager = mocks.managers[0]!;
    await act(async () => {
      manager.onError("https://host.test/api/assets/token/leaves.png");
      manager.onError("https://host.test/api/assets/token/leaves.png");
      manager.onLoad();
    });
    expect(text()).toContain("texture missing");
    expect(text()).toContain("leaves.png");
    expect(material.map).toBeNull();
    expect(mocks.canvases.size).toBe(1);
    expect(surface!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  });

  it("revokes embedded image URLs and carries file revisions to textures", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    await mount(`${src}?workspace-revision=123`);
    const manager = mocks.managers[0]!;
    expect(manager.resolveURL("https://host.test/api/assets/token/leaves.png")).toContain(
      "workspace-revision=123",
    );
    manager.resolveURL("blob:embedded-image");
    manager.resolveURL("blob:embedded-image");
    manager.onLoad();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:embedded-image");
    manager.resolveURL("blob:pending-image");
    await act(async () => {
      surface!.unmount();
    });
    surface = null;
    expect(revoke).toHaveBeenLastCalledWith("blob:pending-image");
  });

  it("offers recovery after context loss and cleans the old renderer on retry", async () => {
    await mount();
    const old = mocks.renderers[0]!;
    await act(async () => {
      old.domElement.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    });
    expect(text()).toContain("3D rendering was interrupted");
    const retry = surface!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Retry model preview")!;
    await act(async () => {
      retry.props.onClick();
    });
    expect(text()).not.toContain("3D rendering was interrupted");
    expect(old.forceContextLoss).toHaveBeenCalledTimes(1);
    expect(mocks.canvases.size).toBe(1);
  });

  it("reports malformed files and can load a valid model after retry", async () => {
    mocks.parse.mockImplementationOnce(() => {
      throw new Error("Invalid FBX header");
    });
    await mount();
    expect(text()).toContain("Invalid FBX header");
    expect(mocks.canvases.size).toBe(0);
    const retry = surface!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Retry model preview")!;
    await act(async () => {
      retry.props.onClick();
    });
    expect(text()).not.toContain("Invalid FBX header");
    expect(mocks.canvases.size).toBe(1);
  });

  it("releases a model with invalid bounds before creating a renderer", async () => {
    const model = createModel();
    model.position.set(Infinity, 0, 0);
    const disposeGeometry = vi.spyOn(model.geometry, "dispose");
    mocks.parse.mockReturnValueOnce(model);
    await mount();
    expect(text()).toContain("valid visible model");
    expect(mocks.renderers).toHaveLength(0);
    expect(disposeGeometry).toHaveBeenCalledTimes(1);
  });
});
