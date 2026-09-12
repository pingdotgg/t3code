import { describe, expect, it } from "vite-plus/test";

import {
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
} from "./threadSidebarWidth";

describe("threadSidebarWidth", () => {
  it("rounds a fractional stored width to whole pixels so the 1px edge border never straddles pixels", () => {
    expect(resolveInitialThreadSidebarWidth(256.4, 1280)).toBe(256);
    expect(resolveInitialThreadSidebarWidth(256.6, 1280)).toBe(257);
  });

  it("keeps the default width on whole pixels", () => {
    expect(resolveInitialThreadSidebarWidth(null, 1280)).toBe(256);
  });

  it("clamps to the maximum width after rounding", () => {
    const max = resolveThreadSidebarMaximumWidth(800);
    expect(resolveInitialThreadSidebarWidth(max + 0.6, 800)).toBe(max);
  });
});
