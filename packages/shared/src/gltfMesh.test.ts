import { describe, expect, it } from "vite-plus/test";

import { expandMesh } from "./testing/meshFixture.ts";
import { parseGltf as parse } from "./gltfMesh.ts";

const parseGltf = async (...args: Parameters<typeof parse>) => expandMesh(await parse(...args));

const LIMITS = { maxTriangles: 1000 };
const signal = new AbortController().signal;

/** A unit square as four points, drawn with two indexed triangles. */
function squareBuffer() {
  const buffer = new ArrayBuffer(4 * 12 + 6 * 2);
  new Float32Array(buffer, 0, 12).set([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  new Uint16Array(buffer, 48, 6).set([0, 1, 2, 0, 2, 3]);
  return new Uint8Array(buffer);
}

function document(buffer: { uri?: string; byteLength: number }, nodes: unknown) {
  return {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: "VEC3" },
      { bufferView: 1, componentType: 5123, count: 6, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48 },
      { buffer: 0, byteOffset: 48, byteLength: 12 },
    ],
    buffers: [buffer],
  };
}

function glb(json: unknown, binary: Uint8Array) {
  const pad = (bytes: Uint8Array, fill: number) => {
    const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4).fill(fill);
    padded.set(bytes);
    return padded;
  };
  const jsonBytes = pad(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const binBytes = pad(binary, 0);
  const bytes = new Uint8Array(12 + 8 + jsonBytes.length + 8 + binBytes.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(jsonBytes, 20);
  view.setUint32(20 + jsonBytes.length, binBytes.length, true);
  view.setUint32(24 + jsonBytes.length, 0x004e4942, true);
  bytes.set(binBytes, 28 + jsonBytes.length);
  return bytes;
}

describe("parseGltf", () => {
  it("reads GLB files, applying node transforms and converting Y-up to Z-up", async () => {
    const nodes = [
      { children: [1], translation: [10, 0, 0] },
      { mesh: 0, scale: [2, 2, 2] },
    ];
    const positions = await parseGltf(
      glb(document({ byteLength: 60 }, nodes), squareBuffer()),
      LIMITS,
      signal,
    );
    expect(positions?.length).toBe(2 * 9);
    // glTF (1, 1, 0) scaled by 2 and moved to x + 10 is (12, 2, 0), which is (12, 0, 2) in Z-up.
    expect([...positions!.subarray(6, 9)]).toEqual([12, 0, 2]);
  });

  it("reads .gltf files with embedded data URIs and rotated nodes", async () => {
    const uri = `data:application/octet-stream;base64,${btoa(String.fromCharCode(...squareBuffer()))}`;
    // A quarter turn about Y takes +X to -Z, which is +Y in Z-up.
    const half = Math.SQRT1_2;
    const json = document({ uri, byteLength: 60 }, [{ mesh: 0, rotation: [0, half, 0, half] }]);
    const positions = await parseGltf(
      new TextEncoder().encode(JSON.stringify(json)),
      LIMITS,
      signal,
    );
    expect([...positions!.subarray(3, 6)].map((value) => Math.round(value) + 0)).toEqual([0, 1, 0]);
  });

  it("returns null for external buffers, compressed meshes and other data", async () => {
    const external = document({ uri: "scene.bin", byteLength: 60 }, [{ mesh: 0 }]);
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    expect(await parseGltf(encode(external), LIMITS, signal)).toBeNull();
    const draco = document({ byteLength: 60 }, [{ mesh: 0 }]);
    draco.accessors[0] = { componentType: 5126, count: 4, type: "VEC3" } as never;
    expect(await parseGltf(glb(draco, squareBuffer()), LIMITS, signal)).toBeNull();
    expect(await parseGltf(new TextEncoder().encode("solid part"), LIMITS, signal)).toBeNull();
    expect(
      await parseGltf(
        glb(document({ byteLength: 60 }, [{ mesh: 0 }]), squareBuffer()),
        { maxTriangles: 1 },
        signal,
      ),
    ).toBeNull();
  });
});
