import { describe, expect, it } from "vitest";

import {
  normalizeWorkspacePathForComparison,
  workspacePathsMatch,
} from "./workspacePaths";

describe("workspace path comparison", () => {
  it("matches differently cased macOS paths that point to the same workspace", () => {
    expect(
      workspacePathsMatch(
        "/Users/codewithabdul/developer/gitdiff/bloop",
        "/Users/codewithabdul/Developer/gitdiff/Bloop/",
        "darwin",
      ),
    ).toBe(true);
  });

  it("matches differently cased Windows paths after normalizing separators", () => {
    expect(
      workspacePathsMatch("C:\\Users\\Abdul\\Repo", "c:/users/abdul/repo/", "win32"),
    ).toBe(true);
  });

  it("keeps Linux path matching case-sensitive", () => {
    expect(workspacePathsMatch("/home/abdul/Repo", "/home/abdul/repo", "linux")).toBe(false);
  });

  it("preserves root paths when trimming trailing separators", () => {
    expect(normalizeWorkspacePathForComparison("/", "linux")).toBe("/");
    expect(normalizeWorkspacePathForComparison("C:\\", "win32")).toBe("c:/");
  });
});
