import { describe, expect, it } from "vite-plus/test";

import { summarizeGitHubRouting } from "./GitHubRoutingSettings";

describe("summarizeGitHubRouting", () => {
  it("is empty when no machine shares", () => {
    expect(summarizeGitHubRouting([{ label: "alvin", permission: "off" }])).toBeNull();
  });

  it("groups sharing machines by permission, read and act first", () => {
    expect(
      summarizeGitHubRouting([
        { label: "alvin", permission: "read" },
        { label: "bb-1", permission: "read-write" },
        { label: "cup2", permission: "off" },
        { label: "Theo's MacBook Pro", permission: "read-write" },
      ]),
    ).toBe("bb-1, Theo's MacBook Pro read and act · alvin read PRs");
  });
});
