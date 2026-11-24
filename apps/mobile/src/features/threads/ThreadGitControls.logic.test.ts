import { expect, it } from "vite-plus/test";

import { compactMenuBranchLabel } from "./ThreadGitControls.logic";

it("keeps emoji whole at both cuts of a long branch name", () => {
  expect(compactMenuBranchLabel("feature/abc😀-long-branch-name-😀-for-menus")).toBe(
    "feature/abc…-for-menus",
  );
});
