import { expect, it, vi } from "vite-plus/test";

import { compactMenuBranchLabel } from "./ThreadGitControls";

vi.mock("@react-navigation/native", () => ({}));
vi.mock("../../components/ui/Dialog", () => ({}));
vi.mock("../../native/useOpenPullRequest", () => ({}));
vi.mock("../../state/session", () => ({}));

it("keeps emoji whole at both cuts of a long branch name", () => {
  expect(compactMenuBranchLabel("feature/abc😀-long-branch-name-😀-for-menus")).toBe(
    "feature/abc…-for-menus",
  );
});
