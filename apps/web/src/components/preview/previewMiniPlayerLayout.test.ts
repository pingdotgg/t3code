import { FILL_PREVIEW_VIEWPORT } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  clampPreviewMiniPlayerPosition,
  PREVIEW_MINI_PLAYER_EDGE_GAP,
  resizePreviewMiniPlayer,
  resolvePreviewMiniPlayerFrame,
  resolvePreviewMiniPlayerSourceSize,
} from "./previewMiniPlayerLayout";

const container = { width: 1_000, height: 700 };
const source = { width: 1_600, height: 1_000 };

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
      bottomInset: 300,
    });
    expect(frame).toEqual({ x: 100, y: PREVIEW_MINI_PLAYER_EDGE_GAP, width: 602, height: 376 });
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
        bottomInset: 0,
      }),
    ).toEqual({ x: 12, y: 300, width: 620, height: 388 });
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

describe("clampPreviewMiniPlayerPosition", () => {
  it("keeps a dragged player within the chat viewport", () => {
    expect(
      clampPreviewMiniPlayerPosition({ x: 900, y: -40 }, container, { width: 360, height: 240 }),
    ).toEqual({ x: 628, y: PREVIEW_MINI_PLAYER_EDGE_GAP });
  });

  it("keeps the player above a growing composer inset", () => {
    expect(
      clampPreviewMiniPlayerPosition(
        { x: 500, y: 448 },
        container,
        { width: 360, height: 240 },
        160,
      ),
    ).toEqual({ x: 500, y: 288 });
  });
});
