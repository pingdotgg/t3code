import { FILL_PREVIEW_VIEWPORT } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  clampPreviewMiniPlayerPosition,
  defaultPreviewMiniPlayerPosition,
  PREVIEW_MINI_PLAYER_EDGE_GAP,
  type PreviewMiniPlayerObstacles,
  resizePreviewMiniPlayer,
  resolveDeviceMiniPlayerCornerRadius,
  resolveDeviceMiniPlayerSourceSize,
  resolvePreviewMiniPlayerFrame,
  resolvePreviewMiniPlayerSourceSize,
} from "./previewMiniPlayerLayout";

const container = { width: 1_000, height: 700 };
const source = { width: 1_600, height: 1_000 };
const gap = PREVIEW_MINI_PLAYER_EDGE_GAP;
// A centered composer stack with margins on each side.
const composer = { left: 100, right: 900, height: 150 };
const obstacles: PreviewMiniPlayerObstacles = { composer };
const tallComposer: PreviewMiniPlayerObstacles = { composer: { ...composer, height: 300 } };

describe("resolvePreviewMiniPlayerSourceSize", () => {
  it("uses the device viewport scaled by zoom", () => {
    expect(
      resolvePreviewMiniPlayerSourceSize({ _tag: "freeform", width: 390, height: 844 }, null, 2),
    ).toEqual({ width: 780, height: 1_688 });
  });

  it("uses the size the fill viewport had when it was floated", () => {
    expect(
      resolvePreviewMiniPlayerSourceSize(
        FILL_PREVIEW_VIEWPORT,
        { x: 0, y: 0, width: 640, height: 400, scale: 0.5, scrollLeft: 0, scrollTop: 0 },
        1,
      ),
    ).toEqual({ width: 1_280, height: 800 });
  });
});

describe("resolveDeviceMiniPlayerSourceSize", () => {
  it("stands in with the platform's phone shape until the stream reports a size", () => {
    const ios = resolveDeviceMiniPlayerSourceSize("ios", null);
    expect(ios.width / ios.height).toBeCloseTo(9 / 19.5);
    const android = resolveDeviceMiniPlayerSourceSize("android", null);
    expect(android.width / android.height).toBeCloseTo(9 / 20);
  });

  it("turns a rotated screen into a landscape box", () => {
    const screen = { width: 1_179, height: 2_556, orientation: "landscape_left" } as const;
    expect(resolveDeviceMiniPlayerSourceSize("ios", screen)).toEqual({
      width: 2_556,
      height: 1_179,
    });
    expect(
      resolveDeviceMiniPlayerSourceSize("android", { ...screen, orientation: "portrait" }),
    ).toEqual({ width: 1_179, height: 2_556 });
  });

  it("floats a phone at the minimum width rather than the default box", () => {
    expect(
      resolvePreviewMiniPlayerFrame({
        width: null,
        position: null,
        source: resolveDeviceMiniPlayerSourceSize("ios", null),
        container,
      }),
    ).toMatchObject({ width: 240, height: 520 });
  });
});

describe("resolveDeviceMiniPlayerCornerRadius", () => {
  it("rounds an Android player like a phone, scaled with its short side", () => {
    expect(resolveDeviceMiniPlayerCornerRadius("android", { width: 240, height: 520 })).toBe(34);
    expect(resolveDeviceMiniPlayerCornerRadius("android", { width: 520, height: 240 })).toBe(34);
    expect(resolveDeviceMiniPlayerCornerRadius("android", { width: 60, height: 130 })).toBe(12);
  });

  it("keeps the frame radius for iOS, whose stream has square corners", () => {
    expect(resolveDeviceMiniPlayerCornerRadius("ios", { width: 240, height: 520 })).toBe(12);
    expect(resolveDeviceMiniPlayerCornerRadius("ios", { width: 720, height: 1_000 })).toBe(12);
  });
});

describe("resolvePreviewMiniPlayerFrame", () => {
  it("opens at the source aspect ratio in the top-right corner", () => {
    expect(
      resolvePreviewMiniPlayerFrame({ width: null, position: null, source, container }),
    ).toEqual({ x: 668, y: PREVIEW_MINI_PLAYER_EDGE_GAP, width: 320, height: 200 });
  });

  it("keeps a tall source at the minimum width instead of the default box", () => {
    expect(
      resolvePreviewMiniPlayerFrame({
        width: null,
        position: null,
        source: { width: 390, height: 844 },
        container,
      }),
    ).toEqual({ x: 748, y: PREVIEW_MINI_PLAYER_EDGE_GAP, width: 240, height: 519 });
  });

  it("derives height from the stored width", () => {
    expect(
      resolvePreviewMiniPlayerFrame({ width: 480, position: { x: 100, y: 80 }, source, container }),
    ).toEqual({ x: 100, y: 80, width: 480, height: 300 });
  });

  it("shrinks to the space above the composer without losing the stored width", () => {
    const frame = resolvePreviewMiniPlayerFrame({
      width: 800,
      position: { x: 100, y: 80 },
      source,
      container,
      obstacles: tallComposer,
    });
    expect(frame).toEqual({ x: 100, y: PREVIEW_MINI_PLAYER_EDGE_GAP, width: 602, height: 376 });
  });

  it("keeps a tall frame parked beside the composer across layout passes", () => {
    // The frame an edge resize produced in the left margin, resolved again from
    // the stored width and position on the next render.
    const phone = { width: 390, height: 844 };
    const beside = { composer: { left: 300, right: 900, height: 300 } };
    const resized = resizePreviewMiniPlayer({
      start: { x: 12, y: 100, width: 240, height: 519 },
      direction: "east",
      delta: { x: 10, y: 0 },
      source: phone,
      container,
      obstacles: beside,
    });
    expect(
      resolvePreviewMiniPlayerFrame({
        width: resized.width,
        position: { x: resized.x, y: resized.y },
        source: phone,
        container,
        obstacles: beside,
      }),
    ).toEqual(resized);
  });

  it("never grows past the source's own rendered size", () => {
    expect(
      resolvePreviewMiniPlayerFrame({
        width: 900,
        position: { x: 12, y: 12 },
        source: { width: 480, height: 320 },
        container,
      }),
    ).toMatchObject({ width: 480, height: 320 });
  });
});

describe("resizePreviewMiniPlayer", () => {
  const start = { x: 300, y: 200, width: 320, height: 200 };

  it("keeps the aspect ratio when dragging the right edge", () => {
    expect(
      resizePreviewMiniPlayer({
        start,
        direction: "east",
        delta: { x: 160, y: 0 },
        source,
        container,
      }),
    ).toEqual({ x: 300, y: 200, width: 480, height: 300 });
  });

  it("anchors the right edge when dragging from the left", () => {
    expect(
      resizePreviewMiniPlayer({
        start,
        direction: "west",
        delta: { x: -160, y: 0 },
        source,
        container,
      }),
    ).toEqual({ x: 140, y: 200, width: 480, height: 300 });
  });

  it("anchors the bottom edge when dragging the top up", () => {
    expect(
      resizePreviewMiniPlayer({
        start,
        direction: "north",
        delta: { x: 0, y: -100 },
        source,
        container,
      }),
    ).toEqual({ x: 300, y: 100, width: 480, height: 300 });
  });

  it("follows the dominant axis on a corner drag", () => {
    expect(
      resizePreviewMiniPlayer({
        start,
        direction: "southeast",
        delta: { x: 20, y: 100 },
        source,
        container,
      }),
    ).toEqual({ x: 300, y: 200, width: 480, height: 300 });
  });

  it("stops at the container edge in the drag direction", () => {
    expect(
      resizePreviewMiniPlayer({
        start: { x: 600, y: 12, width: 320, height: 200 },
        direction: "east",
        delta: { x: 500, y: 0 },
        source,
        container,
      }),
    ).toEqual({ x: 600, y: 12, width: 388, height: 243 });
  });

  it("shifts the player when the free axis would overflow", () => {
    expect(
      resizePreviewMiniPlayer({
        start: { x: 12, y: 400, width: 320, height: 200 },
        direction: "east",
        delta: { x: 300, y: 0 },
        source,
        container,
      }),
    ).toEqual({ x: 12, y: 300, width: 620, height: 388 });
  });

  it("lets a player beside a tall composer keep its height on an edge drag", () => {
    // A portrait player parked in the margin left of the composer, already
    // taller than the rows above the composer, nudged from its right edge.
    const phone = { width: 390, height: 844 };
    const start = { x: 12, y: 100, width: 240, height: 519 };
    const beside = { composer: { left: 300, right: 900, height: 300 } };
    expect(
      resizePreviewMiniPlayer({
        start,
        direction: "east",
        delta: { x: 10, y: 0 },
        source: phone,
        container,
        obstacles: beside,
      }),
    ).toEqual({ x: 12, y: 100, width: 250, height: 541 });
    // The same drag with the composer under the player is still held above it.
    expect(
      resizePreviewMiniPlayer({
        start: { ...start, x: 400 },
        direction: "east",
        delta: { x: 10, y: 0 },
        source: phone,
        container,
        obstacles: beside,
      }),
    ).toMatchObject({ height: 376 });
  });

  it("stops growing downward at the composer beneath the player's columns", () => {
    expect(
      resizePreviewMiniPlayer({
        start: { x: 300, y: 100, width: 320, height: 200 },
        direction: "south",
        delta: { x: 0, y: 400 },
        source,
        container,
        obstacles: tallComposer,
      }),
    ).toEqual({ x: 300, y: 100, width: 461, height: 288 });
  });

  it("respects the minimum size", () => {
    expect(
      resizePreviewMiniPlayer({
        start,
        direction: "southeast",
        delta: { x: -300, y: -300 },
        source,
        container,
      }),
    ).toEqual({ x: 300, y: 200, width: 240, height: 150 });
  });
});

describe("defaultPreviewMiniPlayerPosition", () => {
  it("keeps the top-right fallback when the inline details panel is closed", () => {
    expect(
      defaultPreviewMiniPlayerPosition({
        fallback: { x: 664, y: 16 },
        parentRect: { left: 300, top: 60 },
        playerWidth: 320,
        detailsCardRect: null,
      }),
    ).toEqual({ x: 664, y: 16 });
  });

  it("slides under the inline details card with right edges aligned", () => {
    expect(
      defaultPreviewMiniPlayerPosition({
        fallback: { x: 664, y: 16 },
        parentRect: { left: 300, top: 60 },
        playerWidth: 320,
        detailsCardRect: { right: 1280, bottom: 320 },
      }),
    ).toEqual({
      x: 1280 - 300 - 320,
      y: 320 - 60 + PREVIEW_MINI_PLAYER_EDGE_GAP,
    });
  });
});

describe("clampPreviewMiniPlayerPosition", () => {
  const player = { width: 360, height: 240 };

  it("keeps a dragged player within the chat viewport", () => {
    expect(clampPreviewMiniPlayerPosition({ x: 900, y: -40 }, container, player)).toEqual({
      x: 628,
      y: gap,
    });
  });

  it("keeps the player above a growing composer", () => {
    expect(
      clampPreviewMiniPlayerPosition({ x: 500, y: 448 }, container, player, {
        composer: { ...composer, height: 160 },
      }),
    ).toEqual({ x: 500, y: 288 });
  });

  it("lets the player drop into the margin beside the composer", () => {
    expect(
      clampPreviewMiniPlayerPosition(
        { x: 20, y: 500 },
        container,
        { width: 60, height: 150 },
        obstacles,
      ),
    ).toEqual({ x: 20, y: 500 });
  });

  it("slides sideways past the composer when that is the shorter move", () => {
    expect(
      clampPreviewMiniPlayerPosition(
        { x: 850, y: 500 },
        container,
        { width: 60, height: 150 },
        obstacles,
      ),
    ).toEqual({ x: composer.right + gap, y: 500 });
  });

  it("sits above the composer when it is too wide for either margin", () => {
    expect(
      clampPreviewMiniPlayerPosition(
        { x: 100, y: 100 },
        container,
        { width: 976, height: 500 },
        obstacles,
      ),
    ).toEqual({ x: gap, y: 700 - 150 - gap - 500 });
  });
});
