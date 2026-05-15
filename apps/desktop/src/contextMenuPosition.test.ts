import { describe, expect, it } from "vitest";

import { scaleContextMenuPositionForElectron } from "./contextMenuPosition.ts";

describe("scaleContextMenuPositionForElectron", () => {
  it("scales CSS pixel positions by the renderer zoom factor", () => {
    expect(scaleContextMenuPositionForElectron({ x: 120, y: 80 }, 0.8)).toEqual({
      x: 96,
      y: 64,
    });
    expect(scaleContextMenuPositionForElectron({ x: 120, y: 80 }, 1.25)).toEqual({
      x: 150,
      y: 100,
    });
  });

  it("leaves missing positions missing", () => {
    expect(scaleContextMenuPositionForElectron(undefined, 0.8)).toBeUndefined();
  });

  it("falls back to unscaled coordinates for invalid zoom factors", () => {
    expect(scaleContextMenuPositionForElectron({ x: 120, y: 80 }, 0)).toEqual({
      x: 120,
      y: 80,
    });
    expect(scaleContextMenuPositionForElectron({ x: 120, y: 80 }, Number.NaN)).toEqual({
      x: 120,
      y: 80,
    });
  });
});
