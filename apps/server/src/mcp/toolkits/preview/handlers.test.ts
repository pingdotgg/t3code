import { describe, expect, it } from "vite-plus/test";

import { normalizePreviewNavigateTimeout, normalizePreviewOpenInput } from "./handlers.ts";

describe("normalizePreviewOpenInput", () => {
  it("leaves an unstated visibility for the client preference to decide", () => {
    // Filling `open` in here would outrank `browserAutoShowFloatingPreview`,
    // which is desktop-local and cannot be read from the server.
    expect(normalizePreviewOpenInput({})).toEqual({ reuseExistingTab: true });
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

describe("normalizePreviewNavigateTimeout", () => {
  it("keeps the navigation deadline inside the broker response deadline", () => {
    expect(normalizePreviewNavigateTimeout()).toEqual({
      operationTimeoutMs: 15_000,
      brokerTimeoutMs: 16_000,
    });
    expect(normalizePreviewNavigateTimeout(2_500)).toEqual({
      operationTimeoutMs: 2_500,
      brokerTimeoutMs: 3_500,
    });
  });
});
