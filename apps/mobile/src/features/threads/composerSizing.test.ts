import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_EDITOR_EXPANDED_CONTENT_INSET_VERTICAL,
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

  it("keeps inset-inclusive content unscrolled through the maximum height", () => {
    const textHeight =
      COMPOSER_EDITOR_MAX_HEIGHT - COMPOSER_EDITOR_EXPANDED_CONTENT_INSET_VERTICAL * 2;
    const nativeContentHeight = textHeight + COMPOSER_EDITOR_EXPANDED_CONTENT_INSET_VERTICAL * 2;

    expect(deriveComposerEditorSizing(nativeContentHeight)).toEqual({
      height: COMPOSER_EDITOR_MAX_HEIGHT,
      scrollEnabled: false,
    });
    expect(deriveComposerEditorSizing(nativeContentHeight + 1)).toEqual({
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
