import { Group } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { parseModelInWorker } from "./loadModel";
import type { ModelWorkerRequest, ModelWorkerResponse } from "./model.worker";

class TestWorker extends EventTarget {
  static instances: TestWorker[] = [];
  terminate = vi.fn();
  request: ModelWorkerRequest | null = null;
  constructor() {
    super();
    TestWorker.instances.push(this);
  }
  postMessage(request: ModelWorkerRequest, transfer: ArrayBuffer[]) {
    this.request = structuredClone(request, { transfer });
  }
}

beforeEach(() => {
  TestWorker.instances.length = 0;
  vi.stubGlobal("Worker", TestWorker);
});
afterEach(() => vi.unstubAllGlobals());

describe("Model worker ownership", () => {
  it("transfers input ownership and terminates after successful parsing", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const result = parseModelInWorker(
      bytes,
      "fbx",
      "https://host.test/assets/",
      new AbortController().signal,
    );
    const worker = TestWorker.instances[0]!;
    expect(bytes.byteLength).toBe(0);
    expect(new Uint8Array(worker.request!.bytes)).toEqual(new Uint8Array([1, 2, 3]));
    const model = {
      json: { ...new Group().toJSON(), materials: [], textures: [], skeletons: [], animations: [] },
      geometries: [],
      images: [],
      skinnedBounds: {},
    };
    worker.dispatchEvent(
      new MessageEvent<ModelWorkerResponse>("message", { data: { type: "loaded", model } }),
    );
    await expect(result).resolves.toBe(model);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("stops an in-flight parse immediately on cancellation", async () => {
    const controller = new AbortController();
    const result = parseModelInWorker(new ArrayBuffer(8), "fbx", "", controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    const worker = TestWorker.instances[0]!;
    controller.abort();
    await rejected;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    worker.dispatchEvent(
      new MessageEvent<ModelWorkerResponse>("message", {
        data: { type: "error", message: "Late result" },
      }),
    );
    worker.dispatchEvent(new Event("messageerror"));
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("does not start a worker for an already cancelled load", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      parseModelInWorker(new ArrayBuffer(8), "fbx", "", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(TestWorker.instances).toHaveLength(0);
  });

  it("preserves parser errors and releases the worker", async () => {
    const result = parseModelInWorker(new ArrayBuffer(8), "fbx", "", new AbortController().signal);
    const rejected = expect(result).rejects.toThrow("Invalid FBX header");
    const worker = TestWorker.instances[0]!;
    worker.dispatchEvent(
      new MessageEvent<ModelWorkerResponse>("message", {
        data: { type: "error", message: "Invalid FBX header" },
      }),
    );
    await rejected;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it.each(["error", "messageerror"])("recovers from a worker %s", async (type) => {
    const result = parseModelInWorker(new ArrayBuffer(8), "fbx", "", new AbortController().signal);
    const rejected = expect(result).rejects.toThrow();
    const worker = TestWorker.instances[0]!;
    if (type === "error")
      worker.dispatchEvent(
        Object.assign(new Event("error", { cancelable: true }), { message: "Worker crashed" }),
      );
    else worker.dispatchEvent(new Event("messageerror"));
    await rejected;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
