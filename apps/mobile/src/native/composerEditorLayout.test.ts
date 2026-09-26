import { expect, it } from "vite-plus/test";

import { composerEditorLaidOutHeight, verticalPaddingFromViewStyle } from "./composerEditorLayout";

/** Assert auto-height growth, max-height capping, and padding precedence. */
function testComposerEditorAutoHeight() {
  expect(
    composerEditorLaidOutHeight({
      contentHeight: 240,
      height: 36,
      minHeight: 72,
      maxHeight: 160,
      verticalPadding: 0,
    }),
  ).toBe(36);
  expect(
    composerEditorLaidOutHeight({
      contentHeight: 20,
      minHeight: 72,
      maxHeight: 160,
      verticalPadding: 8,
    }),
  ).toBe(72);
  expect(
    composerEditorLaidOutHeight({
      contentHeight: 100,
      minHeight: 72,
      maxHeight: 160,
      verticalPadding: 8,
    }),
  ).toBe(108);
  expect(
    composerEditorLaidOutHeight({
      contentHeight: 100,
      minHeight: 72,
      maxHeight: 160,
      verticalPadding: 0,
    }),
  ).toBe(100);
  expect(
    composerEditorLaidOutHeight({
      contentHeight: 400,
      minHeight: 72,
      maxHeight: 160,
      verticalPadding: 8,
    }),
  ).toBe(160);
  expect(verticalPaddingFromViewStyle({ paddingVertical: 4 })).toBe(8);
  expect(verticalPaddingFromViewStyle({ paddingTop: 4, paddingBottom: 6 })).toBe(10);
  expect(verticalPaddingFromViewStyle({ padding: 3 })).toBe(6);
  expect(
    verticalPaddingFromViewStyle({
      padding: 2,
      paddingVertical: 4,
      paddingTop: 1,
    }),
  ).toBe(5);
  expect(
    verticalPaddingFromViewStyle({
      paddingVertical: 4,
      paddingBottom: 10,
    }),
  ).toBe(14);
}

/** Register auto-height layout assertions with the test runner. */
it("composer editor auto-height", testComposerEditorAutoHeight);
