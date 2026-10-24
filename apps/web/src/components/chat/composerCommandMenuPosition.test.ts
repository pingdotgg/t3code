/** Covers suggestion placement at the edges of compact and expanded editors. */
import { expect, it } from "vite-plus/test";

import { composerCommandMenuPosition } from "./composerCommandMenuPosition";

const base = {
  rect: { top: 500, left: 100, width: 600 },
  caret: null,
  maximized: false,
  viewportHeight: 800,
  rootFontSize: 16,
  drawerInset: 22,
};

it("keeps compact suggestions above the composer", () => {
  expect(composerCommandMenuPosition(base)).toEqual({
    bottom: 283,
    left: 122,
    width: 556,
    maxHeight: 493,
  });
});

it("places expanded suggestions below text near the top of the viewport", () => {
  expect(
    composerCommandMenuPosition({
      ...base,
      rect: { ...base.rect, top: 0 },
      caret: { top: 50, bottom: 74 },
      maximized: true,
    }),
  ).toEqual({ top: 90, left: 122, width: 556, maxHeight: 686 });
});

it("flips expanded suggestions above text near the bottom of the viewport", () => {
  expect(
    composerCommandMenuPosition({
      ...base,
      rect: { ...base.rect, top: 40 },
      caret: { top: 740, bottom: 764 },
      maximized: true,
    }),
  ).toEqual({ bottom: 76, left: 122, width: 556, maxHeight: 684 });
});

it("keeps a missing selection visible below desktop titlebar clearance", () => {
  const position = composerCommandMenuPosition({
    ...base,
    rect: { ...base.rect, top: 40 },
    maximized: true,
  });
  expect(position).toEqual({ top: 56, left: 122, width: 556, maxHeight: 720 });
});

it("does not position a menu without available width", () => {
  expect(composerCommandMenuPosition({ ...base, rect: { ...base.rect, width: 20 } })).toBeNull();
});
