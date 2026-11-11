import { describe, expect, it } from "vite-plus/test";
import { resolveChatSelectionActionPosition } from "./selectionActions";

describe("selection action positioning", () => {
  const viewport = { width: 800, height: 600 };
  const bounds = { left: 100, top: 100, right: 700, bottom: 500 };
  const actionSize = { width: 80, height: 28 };

  it.each([
    {
      name: "above centered",
      rect: { left: 200, right: 400, top: 200, bottom: 260 },
      expected: { x: 260, y: 166 },
    },
    {
      name: "below at scroll container top",
      rect: { left: 200, right: 400, top: 110, bottom: 160 },
      expected: { x: 260, y: 166 },
    },
    {
      name: "upward release excludes above placement",
      rect: { left: 200, right: 400, top: 200, bottom: 260 },
      pointer: { x: 300, y: 190 },
      expected: { x: 260, y: 266 },
    },
    {
      name: "release excludes below placement too",
      rect: { left: 200, right: 400, top: 110, bottom: 160 },
      pointer: { x: 300, y: 180 },
      expected: { x: 260, y: 108 },
    },
    {
      name: "pinned fallback moves away from the release point",
      rect: { left: 200, right: 400, top: 102, bottom: 498 },
      pointer: { x: 300, y: 115 },
      expected: { x: 260, y: 464 },
    },
    {
      name: "pinned fallback avoids a click just past the release point",
      rect: { left: 200, right: 400, top: 102, bottom: 498 },
      pointer: { x: 261, y: 115 },
      actionSize: { width: 60, height: 24 },
      expected: { x: 270, y: 468 },
    },
    {
      name: "short chat area steps sideways off the release point",
      rect: { left: 200, right: 400, top: 102, bottom: 148 },
      bounds: { ...bounds, top: 100, bottom: 150 },
      pointer: { x: 300, y: 125 },
      expected: { x: 316, y: 108 },
    },
    {
      name: "short nested clip uses outer above placement",
      rect: { left: 200, right: 400, top: 200, bottom: 224 },
      bounds: { ...bounds, top: 188, bottom: 236 },
      outerBounds: bounds,
      expected: { x: 260, y: 166 },
    },
    {
      name: "clamped to window",
      bounds: { ...bounds, bottom: 600 },
      rect: { left: 750, right: 800, top: 580, bottom: 600 },
      expected: { x: 712, y: 546 },
    },
  ])("$name", ({ rect, expected, bounds: clips, ...options }) => {
    expect(
      resolveChatSelectionActionPosition({
        actionSize,
        ...options,
        selectionRect: rect,
        bounds: clips ?? bounds,
        viewport,
      }),
    ).toEqual(expected);
  });
});
