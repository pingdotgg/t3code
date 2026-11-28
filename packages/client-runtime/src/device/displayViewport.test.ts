import { describe, expect, it } from "vite-plus/test";
import { displayRegion, touchArea } from "./displayViewport.ts";

const touch = { x: 0, y: 0, width: 1, height: 1 };
const foldCover = {
  width: 1080,
  height: 2400,
  content: { x: 72, y: 0, width: 936, height: 2400 },
  touch,
};

describe("displayRegion", () => {
  it.each([
    ["the framebuffer", 1080, 2400, { x: 72, y: 0, width: 936, height: 2400 }],
    ["a downscaled stream", 576, 1280, { x: 38, y: 0, width: 499, height: 1280 }],
  ] as const)("crops the bars from %s", (_name, width, height, expected) => {
    expect(displayRegion(foldCover, width, height)).toEqual(expected);
  });

  it("crops bars above and below a display wider than the panel", () => {
    expect(
      displayRegion(
        { width: 1080, height: 2400, content: { x: 0, y: 450, width: 1080, height: 1500 }, touch },
        1080,
        2400,
      ),
    ).toEqual({ x: 0, y: 450, width: 1080, height: 1500 });
  });

  it("crops a frame streamed from an emulator turned on its side", () => {
    expect(displayRegion(foldCover, 1280, 576)).toEqual({ x: 0, y: 38, width: 1280, height: 499 });
    expect(touchArea(foldCover, 1280, 576)).toEqual({
      x: 0,
      y: 72 / 1080,
      width: 1,
      height: 936 / 1080,
    });
  });

  it.each([
    ["a frame already sized to the display", 904, 2316],
    ["a square frame", 1000, 1000],
  ] as const)("shows %s whole and touches it as it is", (_name, width, height) => {
    expect(displayRegion(foldCover, width, height)).toBeNull();
    expect(touchArea(foldCover, width, height)).toBeNull();
  });
});
