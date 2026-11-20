import { expect, it, vi } from "vite-plus/test";

import { stubGlobal } from "../../../test/render";
import {
  reconcileModelNotes,
  type ModelCapture,
} from "@t3tools/client-runtime/model-preview/annotations";
import { loadModelScene } from "./modelScene";

async function capturePixels({ dataUrl, width, height }: ModelCapture) {
  const context = new OffscreenCanvas(width, height).getContext("2d");
  if (!context) throw new Error("The capture could not be decoded");
  const image = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    context.drawImage(image, 0, 0);
  } finally {
    image.close();
  }
  return (x: number, y: number) =>
    Array.from(context.getImageData(Math.floor(x * width), Math.floor(y * height), 1, 1).data);
}

it("marks a note stale when a triangle changes shape within the same bounds", async () => {
  using resources = new DisposableStack();
  const container = document.createElement("div");
  container.style.cssText = "width: 320px; height: 480px; background: black";
  document.body.append(container);
  resources.defer(() => container.remove());

  const loadTriangle = async (thirdX: number) => {
    const bytes = new ArrayBuffer(134);
    const data = new DataView(bytes);
    data.setUint32(80, 1, true);
    [0, 0, 1, 0, 0, 0, 1, 0, 0, thirdX, 1, 0].forEach((value, index) =>
      data.setFloat32(84 + 4 * index, value, true),
    );
    const src = URL.createObjectURL(new Blob([bytes]));
    resources.defer(() => URL.revokeObjectURL(src));
    const scene = await loadModelScene({
      container,
      src,
      format: "stl",
      signal: new AbortController().signal,
    });
    resources.defer(() => scene.dispose());
    return scene;
  };

  const first = await loadTriangle(0);
  const second = await loadTriangle(1);
  const notes = [
    {
      id: "pin",
      number: 1,
      text: "Keep this face",
      point: [0.2, 0.5, 0],
      normal: [0, 0, 1],
      stale: false,
    },
  ] as const;
  expect(first.summary.size).toEqual(second.summary.size);
  expect(first.summary.triangles).toEqual(second.summary.triangles);
  expect(
    reconcileModelNotes(
      { fingerprint: first.summary.fingerprint, notes },
      second.summary.fingerprint,
    ),
  ).toEqual([{ ...notes[0], stale: true }]);
});

async function compressedTriangle3mf(textured: boolean) {
  const { default: JSZip } = await import("jszip");
  const archive = new JSZip();
  archive.file(
    "_rels/.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Target="/3D/model.model"
        Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Id="model"/>
    </Relationships>`,
  );
  archive.file(
    "3D/model.model",
    `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
      xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
      <resources>
        ${
          textured
            ? `<m:texture2d id="2" path="/3D/Textures/face.png" contenttype="image/png"/>
        <m:texture2dgroup id="3" texid="2">
          <m:tex2coord u="0" v="0"/><m:tex2coord u="1" v="0"/><m:tex2coord u="0.5" v="1"/>
        </m:texture2dgroup>`
            : ""
        }
        <object id="1" type="model"><mesh>
        <vertices><vertex x="-1" y="-1" z="0"/><vertex x="1" y="-1" z="0"/><vertex x="0" y="1" z="0"/></vertices>
        <triangles><triangle v1="0" v2="1" v3="2" ${textured ? 'pid="3" p1="0" p2="1" p3="2"' : ""}/></triangles>
      </mesh></object></resources>
      <build><item objectid="1"/></build>
    </model>`,
  );
  if (textured) {
    archive.file(
      "3D/_rels/model.model.rels",
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Target="/3D/Textures/face.png"
          Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dtexture" Id="face"/>
      </Relationships>`,
    );
    const face = new OffscreenCanvas(1, 1);
    const context = face.getContext("2d");
    if (!context) throw new Error("The test texture could not be drawn");
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, 1, 1);
    archive.file("3D/Textures/face.png", await (await face.convertToBlob()).arrayBuffer());
  }
  return archive.generateAsync({ type: "blob", compression: "DEFLATE" });
}

it("loads a compressed 3MF through the bounded archive reader", async () => {
  using resources = new DisposableStack();
  const src = URL.createObjectURL(await compressedTriangle3mf(false));
  resources.defer(() => URL.revokeObjectURL(src));
  const container = document.createElement("div");
  document.body.append(container);
  resources.defer(() => container.remove());
  const scene = await loadModelScene({
    src,
    format: "3mf",
    container,
    signal: new AbortController().signal,
  });
  resources.defer(() => scene.dispose());
  expect(scene.summary.triangles).toBe(1);
});

it("reports a 3MF archive limit through the preview worker", async () => {
  const { default: JSZip } = await import("jszip");
  const archive = new JSZip();
  for (let index = 0; index <= 2048; index++) archive.file(`part-${index}`, "");
  const src = URL.createObjectURL(await archive.generateAsync({ type: "blob" }));
  using resources = new DisposableStack();
  resources.defer(() => URL.revokeObjectURL(src));
  await expect(
    loadModelScene({
      src,
      format: "3mf",
      container: document.createElement("div"),
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ _tag: "ZipError", code: "archive-too-many-entries" });
});

it.each([
  { name: "captures a 3MF's embedded texture as soon as the scene is ready", cancel: false },
  { name: "cancels a 3MF preview while its embedded texture is loading", cancel: true },
])("$name", async ({ cancel }) => {
  using resources = new DisposableStack();
  const src = URL.createObjectURL(await compressedTriangle3mf(true));
  resources.defer(() => URL.revokeObjectURL(src));
  const container = document.createElement("div");
  container.style.cssText = "width: 200px; height: 200px";
  document.body.append(container);
  resources.defer(() => container.remove());
  const setImageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")?.set;
  const textureRequested = Promise.withResolvers<{ url: string; resume: () => void }>();
  using _image = vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(function (
    this: HTMLImageElement,
    url,
  ) {
    if (url.startsWith("blob:")) {
      textureRequested.resolve({ url, resume: () => setImageSrc?.call(this, url) });
    } else {
      setImageSrc?.call(this, url);
    }
  });
  const controller = new AbortController();
  const captured = loadModelScene({
    src,
    format: "3mf",
    container,
    signal: controller.signal,
  }).then((scene) => {
    resources.defer(() => scene.dispose());
    return scene.capture([]);
  });
  const texture = await Promise.race([textureRequested.promise, captured.then(() => undefined)]);
  if (cancel) {
    if (!texture) throw new Error("The preview did not request its embedded texture");
    controller.abort();
    await expect(captured).rejects.toBe(controller.signal.reason);
    expect(container.childElementCount).toBe(0);
    await expect(fetch(texture.url)).rejects.toThrow();
    return;
  }
  texture?.resume();

  const pixel = await capturePixels(await captured);
  const [red = 0, green = 0, blue = 0, alpha = 0] = pixel(0.5, 0.5);
  expect(alpha).toBe(255);
  expect(red - Math.max(green, blue)).toBeGreaterThan(100);
});

it("previews embedded GLB data and refuses a reference to a separate file", async () => {
  const vertices = new Float32Array([0, 0, 0, 1, 0, 1, 0, 1, 0]);
  function modelBytes(uri?: string, instanceDepth?: number) {
    const instances =
      instanceDepth === undefined
        ? null
        : new Float32Array([1, 1, instanceDepth, 1, 1, instanceDepth]);
    const byteLength = vertices.byteLength + (instances?.byteLength ?? 0);
    const json = new TextEncoder().encode(
      JSON.stringify({
        asset: { version: "2.0" },
        extensionsUsed: instances ? ["EXT_mesh_gpu_instancing"] : undefined,
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [
          {
            mesh: 0,
            scale: [2, 1, 1],
            extensions: instances
              ? { EXT_mesh_gpu_instancing: { attributes: { SCALE: 1 } } }
              : undefined,
          },
        ],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        buffers: [{ byteLength, uri }],
        bufferViews: [
          { buffer: 0, byteLength: vertices.byteLength },
          ...(instances
            ? [{ buffer: 0, byteOffset: vertices.byteLength, byteLength: instances.byteLength }]
            : []),
        ],
        accessors: [
          {
            bufferView: 0,
            componentType: 5126,
            count: 3,
            type: "VEC3",
            min: [0, 0, 0],
            max: [1, 1, 1],
          },
          ...(instances ? [{ bufferView: 1, componentType: 5126, count: 2, type: "VEC3" }] : []),
        ],
      }),
    );
    const jsonLength = Math.ceil(json.byteLength / 4) * 4;
    const binaryOffset = 20 + jsonLength;
    const bytes = new Uint8Array(binaryOffset + 8 + byteLength);
    const header = new DataView(bytes.buffer);
    header.setUint32(0, 0x46546c67, true);
    header.setUint32(4, 2, true);
    header.setUint32(8, bytes.byteLength, true);
    header.setUint32(12, jsonLength, true);
    header.setUint32(16, 0x4e4f534a, true);
    bytes.fill(0x20, 20, binaryOffset);
    bytes.set(json, 20);
    header.setUint32(binaryOffset, byteLength, true);
    header.setUint32(binaryOffset + 4, 0x004e4942, true);
    bytes.set(new Uint8Array(vertices.buffer), binaryOffset + 8);
    if (instances)
      bytes.set(new Uint8Array(instances.buffer), binaryOffset + 8 + vertices.byteLength);
    return bytes;
  }

  using resources = new DisposableStack();
  const container = document.createElement("div");
  container.style.cssText = "width: 320px; height: 320px";
  document.body.append(container);
  resources.defer(() => container.remove());
  const load = (uri?: string, signal = new AbortController().signal, instanceDepth?: number) => {
    const src = URL.createObjectURL(new Blob([modelBytes(uri, instanceDepth)]));
    resources.defer(() => URL.revokeObjectURL(src));
    return loadModelScene({ container, src, format: "glb", signal });
  };
  const rect = container.getBoundingClientRect();
  // The node scale makes the face rise one unit over two. The instance triples the rise.
  for (const [instanceDepth, rise] of [
    [undefined, 1],
    [3, 3],
  ] as const) {
    const scene = await load(undefined, undefined, instanceDepth);
    using _scene = { [Symbol.dispose]: () => scene.dispose() };
    expect(scene.summary.triangles).toBe(instanceDepth === undefined ? 1 : 2);
    scene.setPreset("front");
    const [center] = scene.project([{ point: [2 / 3, 1 / 3, rise / 3], normal: [0, 0, 1] }]);
    const normal = scene.pick(rect.left + center!.x, rect.top + center!.y)?.normal;
    expect(normal?.[0]).toBeCloseTo(-rise / Math.hypot(rise, 2));
    expect(normal?.[2]).toBeCloseTo(2 / Math.hypot(rise, 2));
  }
  const fetchResource = globalThis.fetch;
  const waitingForBuffer = Promise.withResolvers<Request>();
  let holdBuffer = false;
  using _fetch = stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    // Match desktop's connect-src policy, which permits blob: but not data:.
    if (url.startsWith("data:")) return Promise.reject(new TypeError("Failed to fetch"));
    if (holdBuffer && input instanceof Request && url.startsWith("blob:")) {
      waitingForBuffer.resolve(input);
      return new Promise<Response>((_resolve, reject) => {
        input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
      });
    }
    return fetchResource(input, init);
  });
  const payload = btoa(String.fromCharCode(...new Uint8Array(vertices.buffer)));
  const uri = `data:application/octet-stream;base64,${payload}`;
  const inline = await load(uri);
  resources.defer(() => inline.dispose());
  expect(inline.summary.triangles).toBe(1);
  await expect(load("separate-buffer.bin")).rejects.toMatchObject({
    code: "model-invalid",
  });

  holdBuffer = true;
  const controller = new AbortController();
  const canceled = load(uri, controller.signal);
  const loadingBuffer = await waitingForBuffer.promise;
  controller.abort();
  expect(loadingBuffer.signal.aborted).toBe(true);
  await expect(canceled).rejects.toBe(controller.signal.reason);
  await expect(fetchResource(loadingBuffer.url)).rejects.toThrow();
});

it("captures colours the file supplies over a transparent background", async () => {
  // One upward triangle per STL; `faceColor` is the Magics 15-bit colour, or null for none.
  const stl = (faceColor: number | null) => {
    const bytes = new ArrayBuffer(134);
    const data = new DataView(bytes);
    if (faceColor !== null) {
      new Uint8Array(bytes).set(new TextEncoder().encode("COLOR="), 0);
      data.setUint32(6, 0xffffffff);
    }
    data.setUint32(80, 1, true);
    [0, 0, 1, -1, -1, 0, 1, -1, 0, 0, 1, 0].forEach((value, index) =>
      data.setFloat32(84 + 4 * index, value, true),
    );
    data.setUint16(132, faceColor ?? 0, true);
    return URL.createObjectURL(new Blob([bytes]));
  };
  using resources = new DisposableStack();
  const container = document.createElement("div");
  container.style.cssText = "width: 200px; height: 200px; background: black";
  document.body.append(container);
  resources.defer(() => container.remove());
  const capture = async (src: string) => {
    resources.defer(() => URL.revokeObjectURL(src));
    const scene = await loadModelScene({
      container,
      src,
      format: "stl",
      signal: new AbortController().signal,
    });
    resources.defer(() => scene.dispose());
    scene.setPreset("top");
    const pixel = await capturePixels(scene.capture([]));
    return { center: pixel(0.5, 0.55), corner: pixel(0, 0) };
  };

  const white = await capture(stl(0x7fff));
  // The display's own theme shows through, so a capture taken in one theme reads in another.
  expect(white.corner[3]).toBe(0);
  const [red = 0, green = 0, blue = 0, alpha = 0] = white.center;
  expect(alpha).toBe(255);
  // A white face lit from above stays white rather than taking the uncoloured STL grey.
  expect(Math.max(red, green, blue) - Math.min(red, green, blue)).toBeLessThanOrEqual(4);
  expect(red).toBeGreaterThan(200);
});
