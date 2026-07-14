import { describe, expect, it } from "vite-plus/test";

import { resolveGitOverviewReviewNavigationAction } from "./git-overview-navigation";

describe("resolveGitOverviewReviewNavigationAction", () => {
  it("replaces the sheet so Back returns directly to the thread", () => {
    expect(resolveGitOverviewReviewNavigationAction("sheet")).toBe("replace");
  });

  it("pushes Review normally when Git is a persistent inspector", () => {
    expect(resolveGitOverviewReviewNavigationAction("inspector")).toBe("navigate");
  });
});
