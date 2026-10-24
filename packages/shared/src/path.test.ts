import { describe, expect, it } from "vite-plus/test";
import {
  workspaceRelativeFilePath,
  newProjectFolderName,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
  resolveWorkspaceFilePath,
  rebaseWorkspaceFilePath,
  composerMentionPath,
} from "./path.ts";

describe("path helpers", () => {
  // regression: #17923 literal colons in names are kept, not parsed as positions
  it.each([
    ["report:123", "/workspace", "/workspace/report:123"],
    ["src/file", "C:\\Workspace\\", "C:\\Workspace\\src\\file"],
    ["~/report:123", "/workspace", "~/report:123"],
  ])("resolves literal path %s within %s", (path, root, expected) => {
    expect(resolveWorkspaceFilePath(path, root)).toBe(expected);
  });

  it("normalizes a bare Windows drive root the same as one with a trailing separator", () => {
    expect(normalizeProjectPathForDispatch("C:")).toBe("C:\\");
    expect(normalizeProjectPathForComparison("C:")).toBe("c:\\");
    expect(normalizeProjectPathForComparison("C:")).toBe(normalizeProjectPathForComparison("C:\\"));
    expect(normalizeProjectPathForComparison("C:")).toBe(normalizeProjectPathForComparison("C:/"));
    expect(normalizeProjectPathForDispatch("C:\\repo\\")).toBe("C:\\repo");
  });

  it("names a new project's folder from any typed name", () => {
    expect(newProjectFolderName("Pinball Stats")).toBe("pinball-stats");
    expect(newProjectFolderName("  Café & Crème!  ")).toBe("cafe-creme");
    expect(newProjectFolderName("../../etc")).toBe("etc");
    expect(newProjectFolderName("🎱🎱")).toBe("project");
    expect(newProjectFolderName(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
    expect(newProjectFolderName("Con")).toBe("con-project");
    expect(newProjectFolderName("LPT1")).toBe("lpt1-project");
    expect(newProjectFolderName("console")).toBe("console");
  });
});

describe("workspaceRelativeFilePath", () => {
  // regression: #9309 POSIX paths compare case-sensitively, Windows paths do not
  it.each([
    ["/Repo/Project/src/main.ts", "/repo/project", null],
    ["C:/USERS/mike/t3code/main.ts", "c:/users/MIKE/t3code", "main.ts"],
    ["/repo/project-two/a.ts", "/repo/project", null],
    // regression: #16354 a `..` that leaves the root is a host path, not a workspace path
    ["/repo/project/../other/notes.md", "/repo/project", null],
    ["C:\\repo\\project\\src\\..\\..\\notes.md", "C:\\repo\\project", null],
    ["/repo/project/docs/a/../b.md", "/repo/project", "docs/a/../b.md"],
  ])("relates %s to %s", (path, workspaceRoot, relativePath) => {
    expect(workspaceRelativeFilePath(path, workspaceRoot)).toBe(relativePath);
  });
});

describe("rebaseWorkspaceFilePath", () => {
  it("re-roots a subdirectory cwd's paths at the checkout, not a same-named root file", () => {
    expect(rebaseWorkspaceFilePath("docs/setup.md", "/wt/a/ios", "/wt/a")).toBe(
      "ios/docs/setup.md",
    );
    expect(rebaseWorkspaceFilePath("docs/setup.md", "/wt/a", "/wt/a")).toBe("docs/setup.md");
  });

  it("keeps paths it cannot place under the root", () => {
    expect(rebaseWorkspaceFilePath("/elsewhere/SKILL.md", "/wt/a/ios", "/wt/a")).toBe(
      "/elsewhere/SKILL.md",
    );
    expect(rebaseWorkspaceFilePath("docs/setup.md", null, "/wt/a")).toBe("docs/setup.md");
  });
});

describe("composer mention paths", () => {
  const nested = { agentCwd: "/wt/a/ios", workspaceRoot: "/wt/a" };

  it("records picker and tree mentions of a subdirectory thread as the same absolute file", () => {
    // The picker searches the agent's cwd; the file tree lists the checkout.
    expect(composerMentionPath("file.ts", nested.agentCwd, nested)).toBe("/wt/a/ios/file.ts");
    expect(composerMentionPath("ios/file.ts", nested.workspaceRoot, nested)).toBe(
      "/wt/a/ios/file.ts",
    );
    expect(composerMentionPath("README.md", nested.workspaceRoot, nested)).toBe("/wt/a/README.md");
    expect(rebaseWorkspaceFilePath("/wt/a/ios/file.ts", "/wt/a", "/wt/a")).toBe("ios/file.ts");
    expect(rebaseWorkspaceFilePath("/wt/a/README.md", "/wt/a", "/wt/a")).toBe("README.md");
  });

  it("keeps relative mentions, including saved ones, relative to the checkout", () => {
    const flat = { agentCwd: "/wt/a/", workspaceRoot: "/wt/a" };
    expect(composerMentionPath("ios/file.ts", "/wt/a", flat)).toBe("ios/file.ts");
    expect(rebaseWorkspaceFilePath("ios/file.ts", "/wt/a", "/wt/a")).toBe("ios/file.ts");
    expect(rebaseWorkspaceFilePath("README.md", "/wt/a", "/wt/a")).toBe("README.md");
  });
});
