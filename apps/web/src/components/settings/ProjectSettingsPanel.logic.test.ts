import { describe, expect, it } from "vite-plus/test";

import { projectGroupTitleNeedsUpdate } from "./ProjectSettingsPanel.logic";

describe("projectGroupTitleNeedsUpdate", () => {
  it("updates divergent member titles even when the next title is the derived group label", () => {
    expect(
      projectGroupTitleNeedsUpdate(["local-title", "remote-title"], "Repository name", true),
    ).toBe(true);
  });

  it("skips an untouched blur when the derived label differs from member titles", () => {
    expect(projectGroupTitleNeedsUpdate(["repo-slug", "repo-slug"], "Repository Name", false)).toBe(
      false,
    );
  });

  it("persists an explicit edit even when every member already has the next title", () => {
    expect(projectGroupTitleNeedsUpdate(["repo", "repo"], "repo", true)).toBe(true);
  });

  it("still skips an untouched blur when member titles diverge", () => {
    expect(
      projectGroupTitleNeedsUpdate(["local-title", "remote-title"], "local-title", false),
    ).toBe(false);
  });
});
