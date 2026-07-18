import { describe, expect, it } from "vite-plus/test";

import { clampVoicePanelGeometry } from "./useVoicePanelGeometry";

describe("clampVoicePanelGeometry", () => {
  it("keeps a panel entirely inside the viewport", () => {
    expect(
      clampVoicePanelGeometry(
        { x: -100, y: 900, width: 400, height: 400 },
        { width: 1_000, height: 800 },
      ),
    ).toEqual({ x: 12, y: 388, width: 400, height: 400 });
  });

  it("enforces minimum and viewport-sized maximum dimensions", () => {
    expect(
      clampVoicePanelGeometry(
        { x: 20, y: 20, width: 10, height: 2_000 },
        { width: 900, height: 700 },
      ),
    ).toEqual({ x: 20, y: 12, width: 320, height: 676 });
  });
});
