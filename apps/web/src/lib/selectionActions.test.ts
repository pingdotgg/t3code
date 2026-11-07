import { describe, expect, it } from "vite-plus/test";
import {
  resolveChatSelectionActionPosition,
  resolveSelectionActionPosition,
} from "./selectionActions";

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
      name: "below at window top",
      rect: { left: 200, right: 400, top: 10, bottom: 30 },
      expected: { x: 260, y: 36 },
      bounds: { ...bounds, top: 0 },
    },
    {
      name: "neither side fits",
      rect: { left: 200, right: 400, top: 102, bottom: 498 },
      expected: { x: 260, y: 108 },
    },
    {
      name: "upward release excludes above placement",
      rect: { left: 200, right: 400, top: 200, bottom: 260 },
      pointer: { x: 300, y: 190 },
      expected: { x: 260, y: 266 },
    },
    {
      name: "release margin excludes nearby above placement",
      rect: { left: 200, right: 400, top: 200, bottom: 260 },
      pointer: { x: 300, y: 198 },
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
      name: "short nested clip uses outer above placement",
      rect: { left: 200, right: 400, top: 200, bottom: 224 },
      bounds: { ...bounds, top: 188, bottom: 236 },
      outerBounds: bounds,
      expected: { x: 260, y: 166 },
    },
    {
      name: "short nested clip uses outer below placement",
      rect: { left: 200, right: 400, top: 110, bottom: 134 },
      bounds: { ...bounds, top: 100, bottom: 146 },
      outerBounds: bounds,
      expected: { x: 260, y: 140 },
    },
    {
      name: "nested clip pins against outer bounds when neither fits",
      rect: { left: 200, right: 400, top: 120, bottom: 480 },
      bounds: { ...bounds, top: 118, bottom: 482 },
      outerBounds: bounds,
      expected: { x: 260, y: 108 },
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
        ...options,
        selectionRect: rect,
        bounds: clips ?? bounds,
        actionSize,
        viewport,
      }),
    ).toEqual(expected);
  });

  it("preserves pointer positioning for terminal actions", () => {
    expect(
      resolveSelectionActionPosition({
        bounds: { left: 100, top: 100, width: 600, height: 400 },
        selectionRect: { right: 400, bottom: 260 },
        pointer: { x: 350, y: 240 },
        viewport,
      }),
    ).toEqual({ x: 350, y: 240 });
  });
});
