import { describe, expect, it } from "vite-plus/test";

import { encodePngIco, readPngDimensions } from "./icon-export.ts";

const pngHeader = (width: number, height: number) => {
  const contents = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(contents);
  contents.write("IHDR", 12, "ascii");
  contents.writeUInt32BE(width, 16);
  contents.writeUInt32BE(height, 20);
  return contents;
};

describe("icon export", () => {
  it("reads dimensions from a PNG IHDR chunk", () => {
    expect(readPngDimensions(pngHeader(1024, 512))).toEqual({ width: 1024, height: 512 });
  });

  it("encodes PNG renditions into an ICO directory", () => {
    const small = pngHeader(16, 16);
    const large = pngHeader(256, 256);
    const ico = encodePngIco([
      { size: 16, contents: small },
      { size: 256, contents: large },
    ]);

    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);
    expect(ico.readUInt8(6)).toBe(16);
    expect(ico.readUInt8(22)).toBe(0);
    expect(ico.readUInt32LE(18)).toBe(38);
    expect(ico.readUInt32LE(34)).toBe(38 + small.length);
    expect(ico.subarray(38, 38 + small.length)).toEqual(small);
    expect(ico.subarray(38 + small.length)).toEqual(large);
  });

  it("rejects duplicate ICO rendition sizes", () => {
    expect(() =>
      encodePngIco([
        { size: 32, contents: pngHeader(32, 32) },
        { size: 32, contents: pngHeader(32, 32) },
      ]),
    ).toThrow("provided more than once");
  });
});
