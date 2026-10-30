import { FILL_PREVIEW_VIEWPORT } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  clampPreviewMiniPlayerPosition,
  PREVIEW_MINI_PLAYER_EDGE_GAP,
  type PreviewMiniPlayerObstacles,
  resizePreviewMiniPlayer,
  resolvePreviewMiniPlayerFrame,
  resolvePreviewMiniPlayerSourceSize,
} from "./previewMiniPlayerLayout";

const container = { width: 1_000, height: 700 };
const source = { width: 1_600, height: 1_000 };
const gap = PREVIEW_MINI_PLAYER_EDGE_GAP;
const composer = { left: 100, right: 900, height: 150 };
const obstacles: PreviewMiniPlayerObstacles = { composer, detailsCard: null };
const tallComposer: PreviewMiniPlayerObstacles = {
  composer: { ...composer, height: 300 },
  detailsCard: null,
};
const detailsCard = { left: 680, right: 988, bottom: 260 };
const withCard: PreviewMiniPlayerObstacles = { composer, detailsCard };

describe("resolvePreviewMiniPlayerSourceSize", () => {
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
    const phone = { width: 390, height: 844 };
    const beside = { composer: { left: 300, right: 900, height: 300 }, detailsCard: null };
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
});

describe("resizePreviewMiniPlayer", () => {
  const start = { x: 300, y: 200, width: 320, height: 200 };

  it("does not jump when corner motion crosses opposing dominant axes", () => {
    const frames = [-99, -100, -101].map((y) =>
      resizePreviewMiniPlayer({
        start,
        direction: "southeast",
        delta: { x: 160, y },
        source,
        container,
      }),
    );
    expect(Math.abs(frames[0]!.width - frames[2]!.width)).toBeLessThanOrEqual(2);
  });

  it("projects corner motion onto the aspect-ratio diagonal", () => {
    expect(
      resizePreviewMiniPlayer({
        start,
        direction: "southeast",
        delta: { x: 20, y: 100 },
        source,
        container,
      }),
    ).toEqual({ x: 300, y: 200, width: 379, height: 237 });
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
    const phone = { width: 390, height: 844 };
    const start = { x: 12, y: 100, width: 240, height: 519 };
    const beside = { composer: { left: 300, right: 900, height: 300 }, detailsCard: null };
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
});

describe("resolvePreviewMiniPlayerFrame with the details card", () => {
  it("opens under the inline details card with right edges aligned", () => {
    expect(
      resolvePreviewMiniPlayerFrame({
        width: null,
        position: null,
        source,
        container,
        obstacles: withCard,
      }),
    ).toEqual({ x: 988 - 320, y: 260 + gap, width: 320, height: 200 });
  });

  it("opens left of the card when it cannot fit beneath it", () => {
    const tallCard = { ...withCard, detailsCard: { ...detailsCard, bottom: 480 } };
    expect(
      resolvePreviewMiniPlayerFrame({
        width: null,
        position: null,
        source,
        container,
        obstacles: tallCard,
      }),
    ).toEqual({ x: 680 - gap - 320, y: 700 - 150 - gap - 200, width: 320, height: 200 });
  });

  it("keeps a stored player's size when the card covers its columns", () => {
    const frame = resolvePreviewMiniPlayerFrame({
      width: 480,
      position: { x: 700, y: 280 },
      source,
      container,
      obstacles: withCard,
    });
    expect(frame).toEqual({
      x: 680 - gap - 480,
      y: 700 - 150 - gap - 300,
      width: 480,
      height: 300,
    });
  });
});

describe("clampPreviewMiniPlayerPosition", () => {
  const player = { width: 360, height: 240 };

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

  it("clears the card and the composer together in a tight column", () => {
    const tight = { composer: { left: 0, right: 1_000, height: 300 }, detailsCard };
    expect(clampPreviewMiniPlayerPosition({ x: 700, y: 600 }, container, player, tight)).toEqual({
      x: 680 - gap - 360,
      y: 700 - 300 - gap - 240,
    });
    expect(
      clampPreviewMiniPlayerPosition(
        { x: 700, y: 600 },
        container,
        { width: 360, height: 400 },
        tight,
      ),
    ).toEqual({ x: 628, y: 260 + gap });
  });

  it("stays inside the container when a full-width card leaves no open rows", () => {
    const wall = {
      composer,
      detailsCard: { left: 0, right: 1_000, bottom: 690 },
    };
    expect(clampPreviewMiniPlayerPosition({ x: 300, y: 500 }, container, player, wall)).toEqual({
      x: 300,
      y: 700 - gap - player.height,
    });
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
