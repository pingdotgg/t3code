import { describe, expect, it } from "vite-plus/test";

import {
  resolveInitialThreadSidebarWidth,
  THREAD_SIDEBAR_DEFAULT_WIDTH,
  THREAD_SIDEBAR_MIN_WIDTH,
} from "./threadSidebarWidth";

describe("thread sidebar width", () => {
  it("uses the default width when no preference is stored", () => {
    expect(resolveInitialThreadSidebarWidth(null)).toBe(THREAD_SIDEBAR_DEFAULT_WIDTH);
  });

  it("uses a stored width in the initial render", () => {
    expect(resolveInitialThreadSidebarWidth(360)).toBe(360);
  });

  it("clamps a stored width to the sidebar minimum", () => {
    expect(resolveInitialThreadSidebarWidth(120)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });
});
