import { describe, expect, it } from "vite-plus/test";

import { expandMesh } from "./testing/meshFixture.ts";
import { parsePly as parse } from "./plyMesh.ts";

const parsePly = async (...args: Parameters<typeof parse>) => expandMesh(await parse(...args));

const LIMITS = { maxTriangles: 1000 };
const signal = new AbortController().signal;

const QUAD = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
];

function header(format: string, extra = "") {
  return `ply
format ${format} 1.0
comment made by a test
element vertex 4
property float x
property float y
property float z
property uchar red
element face 1
property list uchar int vertex_indices
${extra}end_header
`;
}

function binaryPly(littleEndian: boolean) {
  const head = new TextEncoder().encode(
    header(littleEndian ? "binary_little_endian" : "binary_big_endian"),
  );
  const body = new DataView(new ArrayBuffer(4 * 13 + 1 + 4 * 4));
  let offset = 0;
  for (const point of QUAD) {
    for (const value of point) {
      body.setFloat32(offset, value, littleEndian);
      offset += 4;
    }
    body.setUint8(offset, 255);
    offset += 1;
  }
  body.setUint8(offset, 4);
  offset += 1;
  for (const index of [0, 1, 2, 3]) {
    body.setInt32(offset, index, littleEndian);
    offset += 4;
  }
  const bytes = new Uint8Array(head.length + body.byteLength);
  bytes.set(head);
  bytes.set(new Uint8Array(body.buffer), head.length);
  return bytes;
}

describe("parsePly", () => {
  it("reads ASCII files, skipping extra properties", async () => {
    const text = `${header("ascii")}${QUAD.map((point) => `${point.join(" ")} 255`).join("\n")}\n4 0 1 2 3\n`;
    const positions = await parsePly(new TextEncoder().encode(text), LIMITS, signal);
    expect([...positions!]).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]);
  });

  it("reads little- and big-endian binary files", async () => {
    for (const littleEndian of [true, false]) {
      const positions = await parsePly(binaryPly(littleEndian), LIMITS, signal);
      expect(positions?.length).toBe(2 * 9);
      expect([...positions!.subarray(0, 9)]).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0]);
    }
  });

  it("keeps the faces read before a file ends early", async () => {
    const whole = binaryPly(true);
    // The quad's last corner is cut off; its first triangle was already complete.
    expect((await parsePly(whole.subarray(0, whole.length - 4), LIMITS, signal))?.length).toBe(9);
    const text = `${header("ascii")}0 0 0 1\n1 0 0 1\n1 1 0 1\n0 1 0 1\n3 0 1 2\n`;
    const twoFaces = text.replace("element face 1", "element face 2");
    expect((await parsePly(new TextEncoder().encode(twoFaces), LIMITS, signal))?.length).toBe(9);
  });

  it("rejects other data, unknown types and point clouds", async () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    expect(await parsePly(encode("solid part\n"), LIMITS, signal)).toBeNull();
    expect(
      await parsePly(
        encode(header("ascii").replace("uchar red", "quaternion red")),
        LIMITS,
        signal,
      ),
    ).toBeNull();
    const cloud =
      "ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n";
    expect(await parsePly(encode(cloud), LIMITS, signal)).toBeNull();
  });
});
