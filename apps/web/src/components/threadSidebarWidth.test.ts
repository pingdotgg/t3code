import { describe, expect, it } from "vite-plus/test";

import {
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarCssWidth,
  resolveThreadSidebarMaximumWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_DEFAULT_WIDTH,
  THREAD_SIDEBAR_MIN_WIDTH,
} from "./threadSidebarWidth";

describe("thread sidebar width", () => {
  it("uses the default width when no preference is stored", () => {
    expect(resolveInitialThreadSidebarWidth(null, 1200)).toBe(THREAD_SIDEBAR_DEFAULT_WIDTH);
  });

  it("uses a stored width in the initial render", () => {
    expect(resolveInitialThreadSidebarWidth(360, 1200)).toBe(360);
  });

  it("clamps a stored width to the sidebar minimum", () => {
    expect(resolveInitialThreadSidebarWidth(120, 1200)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });

  it("leaves enough room for the main content on a smaller window", () => {
    const viewportWidth = 1000;

    expect(resolveInitialThreadSidebarWidth(900, viewportWidth)).toBe(
      viewportWidth - THREAD_MAIN_CONTENT_MIN_WIDTH,
    );
  });

  it("raises the maximum when the viewport grows", () => {
    expect(resolveThreadSidebarMaximumWidth(1000)).toBe(1000 - THREAD_MAIN_CONTENT_MIN_WIDTH);
    expect(resolveThreadSidebarMaximumWidth(1800)).toBe(1800 - THREAD_MAIN_CONTENT_MIN_WIDTH);
  });

  it("expresses the preferred width with a live viewport clamp", () => {
    expect(resolveThreadSidebarCssWidth(400)).toBe(
      `min(400px, max(${THREAD_SIDEBAR_MIN_WIDTH}px, calc(100vw - ${THREAD_MAIN_CONTENT_MIN_WIDTH}px)))`,
    );
  });

  it("keeps the sidebar minimum when the whole layout is narrower than its minimums", () => {
    expect(resolveInitialThreadSidebarWidth(900, 700)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });
});
