import { describe, expect, it } from "vite-plus/test";

import {
  fileRoutePathSegments,
  resolveFileLinkPath,
  resolveNestedFileLinkPath,
  resolveWorkspaceRelativeFilePath,
} from "./filePath";

describe("resolveNestedFileLinkPath", () => {
  it("resolves a link from a subdirectory cwd against it, inside the checkout", () => {
    expect(resolveNestedFileLinkPath("/wt/ios", "/wt", "../shared/file.ts")).toBe(
      "/wt/shared/file.ts",
    );
    expect(resolveNestedFileLinkPath("/wt/ios", "/wt", "src/a.ts")).toBe("/wt/ios/src/a.ts");
  });

  it("rejects a link that escapes the checkout", () => {
    expect(resolveNestedFileLinkPath("/wt/ios", "/wt", "../../etc/passwd")).toBeNull();
  });

  it("keeps the flat behavior when the cwd is the checkout", () => {
    expect(resolveNestedFileLinkPath("/wt", "/wt", "src/a.ts")).toBe("src/a.ts");
    expect(resolveNestedFileLinkPath("/wt", "/wt", "../x.ts")).toBeNull();
  });
});

describe("resolveFileLinkPath", () => {
  it.each([
    ["/home/maria/project", "~/.agents/AGENTS.md", "/home/maria/.agents/AGENTS.md"],
    ["/Users/maria/project", "~/notes.md", "/Users/maria/notes.md"],
    ["C:\\Users\\maria\\project", "~\\.agents\\AGENTS.md", "C:\\Users\\maria\\.agents\\AGENTS.md"],
  ])("expands a home link from %s", (cwd, path, expected) => {
    expect(resolveFileLinkPath(cwd, path)).toBe(expected);
    expect(fileRoutePathSegments(expected).join("/")).toBe(expected);
  });

  it("does not turn an unresolved home into a workspace path", () => {
    expect(resolveFileLinkPath("/repo", "~/notes.md")).toBeNull();
    expect(resolveFileLinkPath(null, "~/notes.md")).toBeNull();
    expect(resolveFileLinkPath("/repo", "../notes.md")).toBeNull();
  });
});

describe("resolveWorkspaceRelativeFilePath", () => {
  it("converts absolute paths inside the workspace", () => {
    expect(
      resolveWorkspaceRelativeFilePath("/Users/julius/repo", "/Users/julius/repo/src/main.ts"),
    ).toBe("src/main.ts");
    expect(resolveWorkspaceRelativeFilePath("C:\\repo", "c:\\repo\\src\\main.ts")).toBe(
      "src/main.ts",
    );
  });

  it("recognizes home links inside the workspace", () => {
    expect(resolveWorkspaceRelativeFilePath("/home/maria/project", "~/project/src/main.ts")).toBe(
      "src/main.ts",
    );
    expect(
      resolveWorkspaceRelativeFilePath("/home/maria/project", "~/.agents/AGENTS.md"),
    ).toBeNull();
  });

  it("rejects paths outside the workspace", () => {
    expect(resolveWorkspaceRelativeFilePath("/repo", "/other/main.ts")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath("/repo", "../other/main.ts")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath("/repo", "/repo/../outside.txt")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath(null, "/repo/main.ts")).toBeNull();
  });
});
