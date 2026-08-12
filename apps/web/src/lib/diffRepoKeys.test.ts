import { describe, expect, it } from "vite-plus/test";

import { buildRepoFilterOptions, scopedDiffFileKey } from "./diffRepoKeys";

describe("buildRepoFilterOptions", () => {
  it("keeps same-named repository roots independently selectable", () => {
    expect(buildRepoFilterOptions(["/services/api", "/legacy/api"])).toEqual([
      { repoRoot: "/services/api", displayName: "/services/api" },
      { repoRoot: "/legacy/api", displayName: "/legacy/api" },
    ]);
  });

  it("uses compact labels when basenames are unique", () => {
    expect(buildRepoFilterOptions(["/services/api", "/services/web"])).toEqual([
      { repoRoot: "/services/api", displayName: "api" },
      { repoRoot: "/services/web", displayName: "web" },
    ]);
  });
});

describe("scopedDiffFileKey", () => {
  it("separates the same relative file across repositories", () => {
    expect(scopedDiffFileKey("README.md", "/services/api")).not.toBe(
      scopedDiffFileKey("README.md", "/legacy/api"),
    );
  });
});
