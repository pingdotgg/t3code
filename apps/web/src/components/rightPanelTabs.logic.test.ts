import { describe, expect, it, vi } from "vite-plus/test";

import { scrollActiveRightPanelTabIntoView } from "./rightPanelTabs.logic";

describe("scrollActiveRightPanelTabIntoView", () => {
  it("does not scroll the active tab into view during a tab drag", () => {
    const scrollIntoView = vi.fn();

    scrollActiveRightPanelTabIntoView({ scrollIntoView }, true);

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("scrolls the active tab into view outside a tab drag", () => {
    const scrollIntoView = vi.fn();

    scrollActiveRightPanelTabIntoView({ scrollIntoView }, false);

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });
});
