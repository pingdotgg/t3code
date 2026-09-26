import { describe, expect, it } from "vite-plus/test";

import {
  isHoverPeekPointerType,
  shouldClosePeekForPointer,
  SIDEBAR_HOVER_PEEK_REGION_SLACK_PX,
} from "./sidebarHoverPeek";

describe("sidebar hover peek", () => {
  it("arms only for mouse-shaped pointers", () => {
    expect(isHoverPeekPointerType("mouse")).toBe(true);
    // Synthetic events from automation report an empty pointer type.
    expect(isHoverPeekPointerType("")).toBe(true);
    expect(isHoverPeekPointerType("touch")).toBe(false);
    expect(isHoverPeekPointerType("pen")).toBe(false);
  });

  it("keeps the panel open while the pointer is over it", () => {
    expect(shouldClosePeekForPointer({ pointerX: 0, panelWidth: 260, holdOpen: false })).toBe(
      false,
    );
    expect(shouldClosePeekForPointer({ pointerX: 259, panelWidth: 260, holdOpen: false })).toBe(
      false,
    );
  });

  it("tolerates overshooting the panel edge by the slack margin", () => {
    expect(
      shouldClosePeekForPointer({
        pointerX: 260 + SIDEBAR_HOVER_PEEK_REGION_SLACK_PX,
        panelWidth: 260,
        holdOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldClosePeekForPointer({
        pointerX: 260 + SIDEBAR_HOVER_PEEK_REGION_SLACK_PX + 1,
        panelWidth: 260,
        holdOpen: false,
      }),
    ).toBe(true);
  });

  it("never closes under an open menu the panel owns", () => {
    expect(shouldClosePeekForPointer({ pointerX: 900, panelWidth: 260, holdOpen: true })).toBe(
      false,
    );
  });
});
