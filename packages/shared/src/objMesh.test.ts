import { describe, expect, it } from "vite-plus/test";

import { expandMesh } from "./testing/meshFixture.ts";
import { parseObj as parse } from "./objMesh.ts";

const parseObj = async (...args: Parameters<typeof parse>) => expandMesh(await parse(...args));

const LIMITS = { maxTriangles: 1000 };
const signal = new AbortController().signal;
const encode = (text: string) => new TextEncoder().encode(text);

describe("parseObj", () => {
  it("reads faces in every corner form and converts Y-up to Z-up", async () => {
    const positions = await parseObj(
      encode(`# exported
o Part
v 0 0 0
v 1 0 0
v 1 2 0
vt 0 0
vn 0 0 1
f 1 2 3
f 1/1 2/1 3/1
f 1//1 2//1 3//1
f -3/1/1 -2/1/1 -1/1/1
`),
      LIMITS,
      signal,
    );
    expect(positions?.length).toBe(4 * 9);
    // (1, 2, 0) in Y-up becomes (1, 0, 2) in Z-up.
    expect([...positions!.subarray(0, 9)]).toEqual([0, 0, 0, 1, 0, 0, 1, 0, 2]);
    expect([...positions!.subarray(27, 36)]).toEqual([...positions!.subarray(0, 9)]);
  });

  it("splits polygons into a fan and skips faces with bad indices", async () => {
    const positions = await parseObj(
      encode("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\nf 1 2 9\n"),
      LIMITS,
      signal,
    );
    expect(positions?.length).toBe(2 * 9);
  });

  it("rejects files without faces or over the limit", async () => {
    expect(await parseObj(encode("v 0 0 0\nv 1 0 0\n"), LIMITS, signal)).toBeNull();
    expect(await parseObj(new Uint8Array([0x4c, 0x01, 0, 0]), LIMITS, signal)).toBeNull();
    const quad = encode("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n");
    expect(await parseObj(quad, { maxTriangles: 1 }, signal)).toBeNull();
  });
});
