import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_EDITOR_MAX_HEIGHT,
  COMPOSER_EDITOR_MIN_HEIGHT,
  deriveComposerEditorSizing,
} from "./composerSizing";

describe("deriveComposerEditorSizing", () => {
  it("grows between the minimum and maximum heights", () => {
    expect(deriveComposerEditorSizing(120)).toEqual({ height: 120, scrollEnabled: false });
  });

  it("clamps short and long content before enabling scrolling", () => {
    expect(deriveComposerEditorSizing(40)).toEqual({
      height: COMPOSER_EDITOR_MIN_HEIGHT,
      scrollEnabled: false,
    });
    expect(deriveComposerEditorSizing(240)).toEqual({
      height: COMPOSER_EDITOR_MAX_HEIGHT,
      scrollEnabled: true,
    });
  });

  it("falls back safely for invalid native measurements", () => {
    expect(deriveComposerEditorSizing(Number.NaN)).toEqual({
      height: COMPOSER_EDITOR_MIN_HEIGHT,
      scrollEnabled: false,
    });
  });
});
