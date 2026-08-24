import { describe, expect, it } from "vite-plus/test";

import { GitHubIssueDetailGhost } from "./GitHubIssueGhosts";

describe("GitHubIssueDetailGhost", () => {
  // The issue surface used to borrow the pull request ghost, which announced the wrong thing.
  it("announces the surface it stands for", () => {
    const props = GitHubIssueDetailGhost().props as {
      role?: string;
      "aria-label"?: string;
    };

    expect(props.role).toBe("status");
    expect(props["aria-label"]).toBe("Loading issue");
  });
});
