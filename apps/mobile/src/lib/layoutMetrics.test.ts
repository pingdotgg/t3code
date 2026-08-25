import { describe, expect, it } from "vite-plus/test";

import {
  ANDROID_SIDEBAR_PAGE_TITLE_FONT_SIZE,
  ANDROID_SIDEBAR_PAGE_TITLE_LINE_HEIGHT,
  ANDROID_SIDEBAR_PAGE_TITLE_ROW_MIN_HEIGHT,
} from "./layoutMetrics";

describe("Android sidebar page title geometry", () => {
  it("gives the large Threads title a line box that fits inside its row", () => {
    expect(ANDROID_SIDEBAR_PAGE_TITLE_LINE_HEIGHT).toBeGreaterThan(
      ANDROID_SIDEBAR_PAGE_TITLE_FONT_SIZE,
    );
    expect(ANDROID_SIDEBAR_PAGE_TITLE_ROW_MIN_HEIGHT).toBeGreaterThanOrEqual(
      ANDROID_SIDEBAR_PAGE_TITLE_LINE_HEIGHT,
    );
  });
});
