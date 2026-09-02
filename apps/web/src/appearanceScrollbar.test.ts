import { describe, expect, it, vi } from "vite-plus/test";

import { applyAppearanceScrollbarWidth, WIDER_SCROLLBARS_ATTRIBUTE } from "./appearanceScrollbar";

function makeRoot() {
  const toggleAttribute = vi.fn();
  return {
    root: { toggleAttribute } as unknown as HTMLElement,
    toggleAttribute,
  };
}

describe("applyAppearanceScrollbarWidth", () => {
  it("enables wider scrollbars on the app root", () => {
    const { root, toggleAttribute } = makeRoot();

    applyAppearanceScrollbarWidth(root, true);

    expect(toggleAttribute).toHaveBeenCalledWith(WIDER_SCROLLBARS_ATTRIBUTE, true);
  });

  it("restores normal scrollbars when disabled", () => {
    const { root, toggleAttribute } = makeRoot();

    applyAppearanceScrollbarWidth(root, false);

    expect(toggleAttribute).toHaveBeenCalledWith(WIDER_SCROLLBARS_ATTRIBUTE, false);
  });
});
