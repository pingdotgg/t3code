import { describe, expect, it } from "vite-plus/test";

import {
  resolveHtmlRenderRowHeight,
  resolveThreadFeedFixedItemSize,
} from "./thread-feed-item-size";

describe("resolveThreadFeedFixedItemSize", () => {
  it("leaves activity groups to native measurement", () => {
    expect(resolveThreadFeedFixedItemSize("activity-group")).toBeUndefined();
  });

  it("keeps fixed timeline chrome on the premeasured path", () => {
    expect(resolveThreadFeedFixedItemSize("run-fold")).toBe(42);
    expect(resolveThreadFeedFixedItemSize("work-toggle")).toBe(28);
  });
});

describe("resolveHtmlRenderRowHeight", () => {
  const render = {
    attachmentId: "render-chart.html",
    title: "Chart",
    height: 600,
    heights: [
      [320, 540],
      [430, 400],
    ],
  } as const;

  it("reserves the page's measured height while shown and one work row while minimized", () => {
    const row = { render, frameWidth: 320, workRowHeight: 28 };
    expect(resolveHtmlRenderRowHeight({ ...row, collapsed: false })).toBe(548);
    expect(resolveHtmlRenderRowHeight({ ...row, collapsed: true })).toBe(36);
  });

  it("leaves a minimized page to native measurement when text scaling can grow its row", () => {
    const row = { render, frameWidth: 320, workRowHeight: undefined };
    expect(resolveHtmlRenderRowHeight({ ...row, collapsed: true })).toBeUndefined();
    // The shown frame never depends on text scaling.
    expect(resolveHtmlRenderRowHeight({ ...row, collapsed: false })).toBe(548);
  });
});
