import { describe, expect, it } from "vite-plus/test";

import { deriveMenuVerticalPlacement } from "./menu-placement";

const base = { gap: 6, margin: 12, minHeight: 110 };

describe("deriveMenuVerticalPlacement", () => {
  it.each([
    {
      name: "anchor taller than the keyboard-free area stays on screen",
      input: { anchorY: -100, anchorHeight: 1000, overlayHeight: 800, keyboardInset: 300 },
      expected: { maxHeight: 476, top: 12 },
    },
    {
      name: "room below opens down",
      input: { anchorY: 100, anchorHeight: 40, overlayHeight: 800, keyboardInset: 300 },
      expected: { maxHeight: 342, top: 146 },
    },
    {
      name: "room above opens up",
      input: { anchorY: 400, anchorHeight: 40, overlayHeight: 800, keyboardInset: 300 },
      expected: { maxHeight: 382, bottom: 406 },
    },
  ])("$name", ({ input, expected }) => {
    expect(deriveMenuVerticalPlacement({ ...base, ...input })).toEqual(expected);
  });
});
