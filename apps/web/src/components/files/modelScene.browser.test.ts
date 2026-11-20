import { expect, it } from "vite-plus/test";

import { stubGlobal } from "../../../test/render";
import { reconcileModelNotes } from "./modelAnnotations";
import { ModelScene } from "./modelScene";

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
    const scene = await ModelScene.load({
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
    { id: "pin", text: "Keep this face", point: [0.2, 0.5, 0], normal: [0, 0, 1], stale: false },
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

it("loads a compressed 3MF through the bounded archive reader", async () => {
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
    `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
      <resources><object id="1" type="model"><mesh>
        <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
        <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
      </mesh></object></resources>
      <build><item objectid="1"/></build>
    </model>`,
  );
  using resources = new DisposableStack();
  const src = URL.createObjectURL(
    await archive.generateAsync({ type: "blob", compression: "DEFLATE" }),
  );
  resources.defer(() => URL.revokeObjectURL(src));
  const container = document.createElement("div");
  document.body.append(container);
  resources.defer(() => container.remove());
  const scene = await ModelScene.load({
    src,
    format: "3mf",
    container,
    signal: new AbortController().signal,
  });
  resources.defer(() => scene.dispose());
  expect(scene.summary.triangles).toBe(1);
});

it("previews embedded GLB data and refuses a reference to a separate file", async () => {
  const vertices = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  function modelBytes(uri?: string) {
    const json = new TextEncoder().encode(
      JSON.stringify({
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        buffers: [{ byteLength: vertices.byteLength, uri }],
        bufferViews: [{ buffer: 0, byteLength: vertices.byteLength }],
        accessors: [
          {
            bufferView: 0,
            componentType: 5126,
            count: 3,
            type: "VEC3",
            min: [0, 0, 0],
            max: [1, 1, 0],
          },
        ],
      }),
    );
    const jsonLength = Math.ceil(json.byteLength / 4) * 4;
    const binaryOffset = 20 + jsonLength;
    const bytes = new Uint8Array(binaryOffset + 8 + vertices.byteLength);
    const header = new DataView(bytes.buffer);
    header.setUint32(0, 0x46546c67, true);
    header.setUint32(4, 2, true);
    header.setUint32(8, bytes.byteLength, true);
    header.setUint32(12, jsonLength, true);
    header.setUint32(16, 0x4e4f534a, true);
    bytes.fill(0x20, 20, binaryOffset);
    bytes.set(json, 20);
    header.setUint32(binaryOffset, vertices.byteLength, true);
    header.setUint32(binaryOffset + 4, 0x004e4942, true);
    bytes.set(new Uint8Array(vertices.buffer), binaryOffset + 8);
    return bytes;
  }

  using resources = new DisposableStack();
  const container = document.createElement("div");
  document.body.append(container);
  resources.defer(() => container.remove());
  const load = (uri?: string) => {
    const src = URL.createObjectURL(new Blob([modelBytes(uri)]));
    resources.defer(() => URL.revokeObjectURL(src));
    return ModelScene.load({ container, src, format: "glb", signal: new AbortController().signal });
  };
  const scene = await load();
  resources.defer(() => scene.dispose());
  expect(scene.summary.triangles).toBe(1);
  const fetchResource = globalThis.fetch;
  using _fetch = stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    // Match desktop's connect-src policy, which permits blob: but not data:.
    if (url.startsWith("data:")) return Promise.reject(new TypeError("Failed to fetch"));
    return fetchResource(input, init);
  });
  const payload = btoa(String.fromCharCode(...new Uint8Array(vertices.buffer)));
  const inline = await load(`data:application/octet-stream;base64,${payload}`);
  resources.defer(() => inline.dispose());
  expect(inline.summary.triangles).toBe(1);
  await expect(load("separate-buffer.bin")).rejects.toMatchObject({
    code: "model-invalid",
  });
});
