import { describe, expect, it } from "vite-plus/test";

import { resolveThreadPanelPresentation } from "./rightPanelLayout";

describe("resolveThreadPanelPresentation", () => {
  it("uses the stable workspace width minus the real right panel width", () => {
    expect(resolveThreadPanelPresentation(null, 0, false)).toBe("inline");
    expect(resolveThreadPanelPresentation(960, 0, false)).toBe("inline");
    expect(resolveThreadPanelPresentation(959, 0, false)).toBe("popover");

    expect(resolveThreadPanelPresentation(1_400, 0, false)).toBe("inline");
    expect(resolveThreadPanelPresentation(1_400, 540, false)).toBe("popover");
    expect(resolveThreadPanelPresentation(1_500, 540, false)).toBe("inline");
  });

  it("uses a popover while the real right panel is maximized", () => {
    expect(resolveThreadPanelPresentation(2_000, 0, true)).toBe("popover");
  });
});
