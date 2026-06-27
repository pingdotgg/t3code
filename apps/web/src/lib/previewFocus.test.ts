import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { isPreviewFocused, setNativePreviewFocused } from "./previewFocus";

describe("previewFocus", () => {
  afterEach(() => {
    setNativePreviewFocused("tab-native", false);
    vi.unstubAllGlobals();
  });

  it("tracks focus owned by a native preview view", () => {
    vi.stubGlobal("HTMLElement", function HTMLElement() {});
    vi.stubGlobal("document", { activeElement: null });

    expect(isPreviewFocused()).toBe(false);
    setNativePreviewFocused("tab-native", true);
    expect(isPreviewFocused()).toBe(true);
    setNativePreviewFocused("tab-native", false);
    expect(isPreviewFocused()).toBe(false);
  });
});
