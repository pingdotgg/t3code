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
      name: "clamped to window",
      rect: { left: 750, right: 800, top: 580, bottom: 600 },
      expected: { x: 712, y: 546 },
    },
  ])("$name", ({ rect, expected, bounds: clips }) => {
    expect(
      resolveChatSelectionActionPosition({
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
