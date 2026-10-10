import { Mesh, MeshPhongMaterial, MeshStandardMaterial, Points } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { parseModelForTransfer } from "./modelWorkerParser";
import { restoreModel } from "./modelTransfer";
import { disposeModel } from "./modelResources";

const basePath = "https://host.test/api/assets/token/";
const encode = (text: string) => new TextEncoder().encode(text).buffer;
const vertices = new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]);

function gltfFixture(binary = false, embeddedImage = false) {
  const image = new Uint8Array([137, 80, 78, 71]);
  const buffer = new Uint8Array(vertices.byteLength + (embeddedImage ? image.length : 0));
  buffer.set(new Uint8Array(vertices.buffer));
  if (embeddedImage) buffer.set(image, vertices.byteLength);
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    buffers: [{ byteLength: buffer.byteLength, ...(binary ? {} : { uri: "mesh.bin" }) }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: vertices.byteLength, byteStride: 24 },
      ...(embeddedImage
        ? [{ buffer: 0, byteOffset: vertices.byteLength, byteLength: image.length }]
        : []),
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      { bufferView: 0, byteOffset: 12, componentType: 5126, count: 3, type: "VEC3" },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }] }],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: 0.2,
          roughnessFactor: 0.7,
        },
      },
    ],
    textures: [{ source: 0 }],
    images: [
      embeddedImage ? { bufferView: 1, mimeType: "image/png" } : { uri: "textures/color.png" },
    ],
  };
  if (!binary) return { bytes: encode(JSON.stringify(json)), buffer, image };
  const rawJson = new TextEncoder().encode(JSON.stringify(json));
  const jsonBytes = new Uint8Array(Math.ceil(rawJson.length / 4) * 4).fill(32);
  jsonBytes.set(rawJson);
  const glb = new ArrayBuffer(12 + 8 + jsonBytes.length + 8 + buffer.length);
  const view = new DataView(glb);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, glb.byteLength, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(glb).set(jsonBytes, 20);
  const offset = 20 + jsonBytes.length;
  view.setUint32(offset, buffer.length, true);
  view.setUint32(offset + 4, 0x004e4942, true);
  new Uint8Array(glb).set(buffer, offset + 8);
  return { bytes: glb, buffer, image };
}

beforeEach(() => {
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("ProgressEvent", class extends Event {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("model worker parsing without a DOM", () => {
  it("loads glTF companion buffers with revisions, preserving interleaved geometry and PBR textures", async () => {
    const fixture = gltfFixture();
    const fetchFile = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(fixture.buffer));
    const { payload, transfer } = await parseModelForTransfer(
      fixture.bytes,
      "gltf",
      basePath,
      "42",
    );
    const request = fetchFile.mock.calls[0]![0];
    expect(request instanceof Request ? request.url : String(request)).toContain(
      "mesh.bin?workspace-revision=42",
    );
    expect(payload.images[0]!.url).toBe(`${basePath}textures/color.png?workspace-revision=42`);
    const { model } = restoreModel(structuredClone(payload, { transfer }));
    const mesh = model.children[0] as Mesh;
    expect(mesh.geometry.getAttribute("position").count).toBe(3);
    expect(mesh.geometry.getAttribute("normal").getZ(2)).toBe(1);
    const material = mesh.material as MeshStandardMaterial;
    expect(material.metalness).toBe(0.2);
    expect(material.roughness).toBe(0.7);
    expect(material.map!.flipY).toBe(false);
    expect(material.map!.image).toBeNull();
    disposeModel(model);
  });

  it("preserves GLB embedded image bytes across worker transfer and termination", async () => {
    const fixture = gltfFixture(true, true);
    const { payload, transfer } = await parseModelForTransfer(fixture.bytes, "gltf", basePath);
    const received = structuredClone(payload, { transfer });
    expect(received.images[0]!.url).toBeInstanceOf(Blob);
    const image = received.images[0]!.url as Blob;
    expect(image.type).toBe("image/png");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(fixture.image);
    const { model } = restoreModel(received);
    expect((model.children[0] as Mesh).geometry.getAttribute("position").getX(1)).toBe(1);
    disposeModel(model);
  });

  it("loads OBJ materials relative to each library, without fetching images in the worker", async () => {
    const fetchFile = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("newmtl Red\nKd 1 0 0\nmap_Kd color.png\n"));
    const obj = "mtllib materials/colors.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl Red\nf 1 2 3\n";
    const { payload } = await parseModelForTransfer(encode(obj), "obj", basePath, "42");
    expect(fetchFile).toHaveBeenCalledExactlyOnceWith(
      `${basePath}materials/colors.mtl?workspace-revision=42`,
    );
    expect(payload.images[0]!.url).toBe(`${basePath}materials/color.png?workspace-revision=42`);
    const { model } = restoreModel(payload);
    const mesh = model.children[0] as Mesh;
    expect(mesh.geometry.getAttribute("position").count).toBe(3);
    expect((mesh.material as MeshPhongMaterial).color.getHex()).toBe(0xff0000);
    disposeModel(model);
  });

  it("keeps OBJ geometry visible when a material library is missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("missing", { status: 404 }));
    const { payload } = await parseModelForTransfer(
      encode("mtllib absent.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl Red\nf 1 2 3\n"),
      "obj",
      basePath,
    );
    expect(payload.warnings).toEqual([
      "Material library missing: absent.mtl. Showing available materials.",
    ]);
    const { model } = restoreModel(payload);
    expect((model.children[0] as Mesh).geometry.getAttribute("position").count).toBe(3);
    disposeModel(model);
  });

  it.each([false, true])("parses STL triangles (binary: %s)", async (binary) => {
    let bytes = encode(
      "solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid triangle\n",
    );
    if (binary) {
      bytes = new ArrayBuffer(134);
      const view = new DataView(bytes);
      view.setUint32(80, 1, true);
      view.setFloat32(92, 1, true);
      view.setFloat32(108, 1, true);
      view.setFloat32(124, 1, true);
    }
    const { payload, transfer } = await parseModelForTransfer(bytes, "stl", basePath);
    const { model } = restoreModel(structuredClone(payload, { transfer }));
    expect(model).toBeInstanceOf(Mesh);
    expect((model as Mesh).geometry.getAttribute("position").count).toBe(3);
    expect((model as Mesh).geometry.getAttribute("position").getX(1)).toBe(1);
    disposeModel(model);
  });

  it.each([false, true])(
    "renders PLY as a mesh when it has faces, otherwise as points (faces: %s)",
    async (faces) => {
      const ply = `ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\n${faces ? "element face 1\nproperty list uchar int vertex_indices\n" : ""}end_header\n0 0 0 255 0 0\n1 0 0 0 255 0\n0 1 0 0 0 255\n${faces ? "3 0 1 2\n" : ""}`;
      const { payload } = await parseModelForTransfer(encode(ply), "ply", basePath);
      const { model } = restoreModel(payload);
      expect(model).toBeInstanceOf(faces ? Mesh : Points);
      const geometry = (model as Mesh | Points).geometry;
      expect(geometry.getAttribute("position").count).toBe(3);
      expect(geometry.getAttribute("color").getX(0)).toBe(1);
      if (faces) expect(geometry.getAttribute("normal").getZ(0)).toBe(1);
      disposeModel(model);
    },
  );

  it("surfaces glTF compression that needs a decoder", async () => {
    const json = {
      asset: { version: "2.0" },
      extensionsUsed: ["KHR_draco_mesh_compression"],
      extensionsRequired: ["KHR_draco_mesh_compression"],
    };
    await expect(
      parseModelForTransfer(encode(JSON.stringify(json)), "gltf", basePath),
    ).rejects.toThrow("This model uses Draco compression, which is not supported in previews yet.");
  });

  it("loads binary PLY geometry and vertex colors", async () => {
    const header = new TextEncoder().encode(
      "ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n",
    );
    const bytes = new Uint8Array(header.length + 45 + 13);
    bytes.set(header);
    const view = new DataView(bytes.buffer);
    for (let vertex = 0; vertex < 3; vertex++) {
      const offset = header.length + vertex * 15;
      view.setFloat32(offset, vertex === 1 ? 1 : 0, true);
      view.setFloat32(offset + 4, vertex === 2 ? 1 : 0, true);
      bytes[offset + 12 + vertex] = 255;
    }
    const face = header.length + 45;
    bytes[face] = 3;
    for (let index = 0; index < 3; index++) view.setInt32(face + 1 + index * 4, index, true);
    const { payload } = await parseModelForTransfer(bytes.buffer, "ply", basePath);
    const { model } = restoreModel(payload);
    const geometry = (model as Mesh).geometry;
    expect(geometry.getAttribute("position").getX(1)).toBe(1);
    expect(geometry.getAttribute("color").getY(1)).toBe(1);
    expect(geometry.index!.array).toEqual(new Uint16Array([0, 1, 2]));
    disposeModel(model);
  });
});
