import { describe, expect, it } from "vite-plus/test";

import { openOnHostLabel, pullRequestLinkContextMenuItems } from "./pullRequestLinkContextMenu";

describe("pull request link context menu", () => {
  it("offers the copy first and the host's own page after it", () => {
    expect(pullRequestLinkContextMenuItems("Open on GitHub")).toEqual([
      { id: "copy-link", label: "Copy link", icon: "copy" },
      { id: "open-external", label: "Open on GitHub" },
    ]);
  });

  it("names every host it knows, and says nothing false about one it does not", () => {
    expect(openOnHostLabel("github")).toBe("Open on GitHub");
    expect(openOnHostLabel("gitlab")).toBe("Open on GitLab");
    expect(openOnHostLabel("bitbucket")).toBe("Open on Bitbucket");
    expect(openOnHostLabel("azure-devops")).toBe("Open on Azure DevOps");
    expect(openOnHostLabel("something-else")).toBe("Open on host");
  });
});
