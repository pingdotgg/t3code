import { describe, expect, it } from "vite-plus/test";

import { fitVideoFrame, inlineVideoFrame } from "./videoFrameFit";

describe("fitVideoFrame", () => {
  const bounds = { width: 360, height: 600 };

  it("keeps landscape videos at the full capped width", () => {
    expect(fitVideoFrame({ width: 1920, height: 1080 }, bounds, 480)).toEqual({
      width: 360,
      height: 202.5,
    });
  });

  it("limits portrait videos by the available height", () => {
    expect(fitVideoFrame({ width: 1080, height: 1920 }, bounds, 480)).toEqual({
      width: 337.5,
      height: 600,
    });
  });

  it("caps wide bounds at the inline width", () => {
    expect(fitVideoFrame({ width: 1080, height: 1080 }, { width: 800, height: 900 }, 480)).toEqual({
      width: 480,
      height: 480,
    });
  });

  it("returns null before the video or bounds have a size", () => {
    expect(fitVideoFrame({ width: 0, height: 0 }, bounds, 480)).toBeNull();
    expect(fitVideoFrame({ width: 1080, height: 1920 }, { width: 0, height: 0 }, 480)).toBeNull();
  });
});

describe("inlineVideoFrame", () => {
  it("caps portrait videos by height and landscape videos by width", () => {
    expect(inlineVideoFrame({ width: 1080, height: 1920 }, 480)).toEqual({
      width: "100%",
      maxWidth: 270,
      aspectRatio: 0.5625,
    });
    expect(inlineVideoFrame({ width: 1920, height: 1080 }, 480)).toMatchObject({ maxWidth: 480 });
  });

  it("returns null without a usable size", () => {
    expect(inlineVideoFrame(undefined, 480)).toBeNull();
    expect(inlineVideoFrame({ width: 0, height: 1080 }, 480)).toBeNull();
  });
});
