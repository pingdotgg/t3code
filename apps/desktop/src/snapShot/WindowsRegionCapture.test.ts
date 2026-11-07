import * as NodeZlib from "node:zlib";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "vite-plus/test";

import { encodeBgraPng, loadWindowsRegionCapture } from "./WindowsRegionCapture.ts";

function readChunks(png: Buffer) {
  const chunks: Array<{ type: string; data: Buffer }> = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    assert.equal(
      png.readUInt32BE(offset + 8 + length),
      NodeZlib.crc32(png.subarray(offset + 4, offset + 8 + length)),
    );
    chunks.push({ type, data });
    offset += 12 + length;
  }
  return chunks;
}

it("encodes GetDIBits rows as an opaque RGB PNG", () => {
  // 2x2 top-down BGRX: blue, green / red, white. GetDIBits leaves the fourth byte undefined.
  const bgra = Buffer.from([255, 0, 0, 0, 0, 255, 0, 7, 0, 0, 255, 0, 255, 255, 255, 7]);

  const png = encodeBgraPng(bgra, 2, 2);

  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const [header, data, end] = readChunks(png);
  assert.equal(header?.type, "IHDR");
  assert.equal(header?.data.readUInt32BE(0), 2);
  assert.equal(header?.data.readUInt32BE(4), 2);
  // 8-bit truecolor with no alpha channel, so every pixel is opaque.
  assert.deepEqual([...(header?.data.subarray(8) ?? [])], [8, 2, 0, 0, 0]);
  assert.equal(data?.type, "IDAT");
  assert.deepEqual(
    [...NodeZlib.inflateSync(data!.data)],
    [0, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 255, 255],
  );
  assert.equal(end?.type, "IEND");
});

it.skipIf(HostProcess.Platform.defaultValue() !== "win32")(
  "copies a physical desktop rect through GDI",
  async () => {
    const capture = await loadWindowsRegionCapture();

    const shot = capture({ x: 0, y: 0, width: 5, height: 3 });

    assert.equal(shot.width, 5);
    assert.equal(shot.height, 3);
    const [header, data] = readChunks(shot.png);
    assert.equal(header?.data.readUInt32BE(0), 5);
    assert.equal(header?.data.readUInt32BE(4), 3);
    assert.lengthOf(NodeZlib.inflateSync(data!.data), (5 * 3 + 1) * 3);
  },
);
