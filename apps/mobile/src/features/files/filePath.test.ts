import { describe, expect, it } from "vite-plus/test";

import {
  fileRoutePathSegments,
  resolveFileLinkPath,
  isSvgImagePreviewFile,
  resolveWorkspaceRelativeFilePath,
  fileHeaderSubtitle,
} from "./filePath";

describe("fileRoutePathSegments", () => {
  it("round-trips workspace-relative and host paths through the route", () => {
    expect(fileRoutePathSegments("src/main.ts")).toEqual(["src", "main.ts"]);
    expect(fileRoutePathSegments("/tmp/t3-cleanup/report.md").join("/")).toBe(
      "/tmp/t3-cleanup/report.md",
    );
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
  it("keeps normalized workspace-relative paths", () => {
    expect(resolveWorkspaceRelativeFilePath("/repo", "./src/../src/main.ts")).toBe("src/main.ts");
  });

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

describe("file preview types", () => {
  it("identifies SVG images that need web rendering", () => {
    expect(isSvgImagePreviewFile("assets/diagram.svg#icon")).toBe(true);
    expect(isSvgImagePreviewFile("assets/photo.png")).toBe(false);
  });
});

describe("fileHeaderSubtitle", () => {
  it("places a workspace file under its project", () => {
    expect(
      fileHeaderSubtitle("t3code", "apps/mobile/src/features/threads/fileChipMenu.test.ts"),
    ).toBe("t3code · apps/mobile/src/features/threads");
  });

  it("shows only the directory for a host file outside the workspace", () => {
    expect(fileHeaderSubtitle("t3code", "/tmp/report.md")).toBe("/tmp");
  });

  it("shows only the project for a file at the workspace root", () => {
    expect(fileHeaderSubtitle("t3code", "README.md")).toBe("t3code");
  });
});
