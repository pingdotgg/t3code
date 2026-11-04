import { describe, expect, it } from "vite-plus/test";

import { expandMesh } from "./testing/meshFixture.ts";
import { parseStl as parse } from "./stlMesh.ts";

const parseStl = async (...args: Parameters<typeof parse>) => expandMesh(await parse(...args));

const LIMITS = { maxTriangles: 1000 };
const signal = new AbortController().signal;

function binaryStl(triangles: ReadonlyArray<ReadonlyArray<number>>, header = "") {
  const bytes = new Uint8Array(84 + triangles.length * 50);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(header.slice(0, 80)));
  view.setUint32(80, triangles.length, true);
  triangles.forEach((triangle, index) =>
    triangle.forEach((value, offset) =>
      view.setFloat32(84 + index * 50 + 12 + offset * 4, value, true),
    ),
  );
  return bytes;
}

/** A unit cube as twelve triangles. */
const CUBE = (() => {
  const corners = [0, 1].flatMap((x) => [0, 1].flatMap((y) => [0, 1].map((z) => [x, y, z])));
  const faces = [
    [0, 1, 3, 2],
    [4, 6, 7, 5],
    [0, 4, 5, 1],
    [2, 3, 7, 6],
    [0, 2, 6, 4],
    [1, 5, 7, 3],
  ];
  return faces.flatMap(([a, b, c, d]) => [
    [...corners[a!]!, ...corners[b!]!, ...corners[c!]!],
    [...corners[a!]!, ...corners[c!]!, ...corners[d!]!],
  ]);
})();

describe("parseStl", () => {
  it("reads binary files, including ones whose header starts with solid", async () => {
    for (const header of ["", "solid exported by a CAD tool"]) {
      const positions = await parseStl(binaryStl(CUBE, header), LIMITS, signal);
      expect(positions?.length).toBe(CUBE.length * 9);
      expect([...positions!.subarray(0, 9)]).toEqual(CUBE[0]);
    }
  });

  it("reads ASCII files", async () => {
    const text = `solid part
  facet normal 0 0 0
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1.5e0 0
    endloop
  endfacet
endsolid part`;
    const positions = await parseStl(new TextEncoder().encode(text), LIMITS, signal);
    expect([...positions!]).toEqual([0, 0, 0, 1, 0, 0, 0, 1.5, 0]);
  });

  it("rejects empty, oversized and unrelated data", async () => {
    expect(await parseStl(binaryStl([]), LIMITS, signal)).toBeNull();
    expect(await parseStl(binaryStl(CUBE), { maxTriangles: 11 }, signal)).toBeNull();
    expect(await parseStl(new TextEncoder().encode("PK\u0003\u0004"), LIMITS, signal)).toBeNull();
    expect(
      await parseStl(new TextEncoder().encode("solid empty\nendsolid"), LIMITS, signal),
    ).toBeNull();
  });
});
