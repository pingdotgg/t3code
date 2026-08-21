import { describe, expect, it } from "vite-plus/test";

import { projectGroupTitleNeedsUpdate } from "./ProjectSettingsPanel.logic";

describe("projectGroupTitleNeedsUpdate", () => {
  it("updates divergent member titles even when the next title is the derived group label", () => {
    expect(projectGroupTitleNeedsUpdate(["local-title", "remote-title"], "Repository name")).toBe(
      true,
    );
  });

  it("skips an update when every member already has the next title", () => {
    expect(projectGroupTitleNeedsUpdate(["Shared name", "Shared name"], "Shared name")).toBe(false);
  });
});
