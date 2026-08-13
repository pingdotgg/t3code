import { describe, expect, it } from "vite-plus/test";

import { normalizePreviewOpenInput } from "./handlers.ts";

describe("normalizePreviewOpenInput", () => {
  it("opens the inline preview and reuses the current tab by default", () => {
    expect(normalizePreviewOpenInput({})).toEqual({
      open: true,
      reuseExistingTab: true,
      show: true,
    });
  });

  it("preserves an explicit background-only opt-out", () => {
    expect(normalizePreviewOpenInput({ open: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
  });

  it("supports show as a legacy alias while preferring open", () => {
    expect(normalizePreviewOpenInput({ show: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
    expect(normalizePreviewOpenInput({ open: true, show: false })).toEqual({
      open: true,
      reuseExistingTab: true,
      show: true,
    });
  });
});
