import { describe, expect, it } from "bun:test";

import {
  assertRgbaImage,
  encodeKittyDelete,
  encodeKittyTransmit,
  KITTY_CHUNK_SIZE,
} from "./kittyProtocol.ts";

describe("Kitty graphics protocol", () => {
  it("encodes a positioned RGBA transmission", () => {
    const data = new Uint8Array([255, 0, 128, 255]);
    const output = encodeKittyTransmit({
      imageId: 7,
      x: 2,
      y: 3,
      imageWidth: 1,
      imageHeight: 1,
      columns: 4,
      rows: 2,
      data,
    });

    expect(output).toStartWith("\x1b[4;3H");
    expect(output).toContain("a=T,f=32,s=1,v=1,c=4,r=2,i=7,m=0,q=2;");
    expect(output).toContain("/wCA/w==");
  });

  it("chunks large payloads below the terminal control-sequence limit", () => {
    const data = new Uint8Array(KITTY_CHUNK_SIZE * 2);
    const output = encodeKittyTransmit({
      imageId: 9,
      x: 0,
      y: 0,
      imageWidth: KITTY_CHUNK_SIZE / 4,
      imageHeight: 2,
      columns: 1,
      rows: 1,
      data,
    });

    expect(output).toContain("i=9,m=1,q=2;");
    expect(output.split("\x1b_Gm=").length - 1).toBeGreaterThanOrEqual(1);
    expect(output).toContain("\x1b_Gm=0,q=2;");
  });

  it("encodes quiet deletion by image id", () => {
    expect(encodeKittyDelete(42)).toBe("\x1b_Ga=d,d=i,i=42,q=2\x1b\\");
  });

  it("rejects malformed RGBA buffers before emitting terminal bytes", () => {
    expect(() => assertRgbaImage(new Uint8Array(3), 1, 1)).toThrow(
      "RGBA data length must be 4 bytes",
    );
    expect(() => assertRgbaImage(new Uint8Array(), 0, 1)).toThrow(
      "imageWidth must be a positive safe integer",
    );
  });
});
