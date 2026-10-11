import { describe, expect, it } from "vite-plus/test";

import {
  expandHomeFilePath,
  fileRoutePathSegments,
  isSvgImagePreviewFile,
  resolveWorkspaceRelativeFilePath,
  fileHeaderSubtitle,
} from "./filePath";

describe("expandHomeFilePath", () => {
  it.each([
    ["/Users/tommy/repo", "/Users/tommy/.zshrc"],
    ["/home/tommy/repo", "/home/tommy/.zshrc"],
    ["C:\\Users\\tommy\\repo", "C:\\Users\\tommy\\.zshrc"],
  ])("expands host-home paths inferred from %s", (workspaceRoot, expected) => {
    expect(expandHomeFilePath("~/.zshrc", workspaceRoot)).toBe(expected);
  });

  it.each([null, undefined, "/repo"])(
    "keeps home paths when home cannot be inferred from %s",
    (root) => {
      expect(expandHomeFilePath("~/.zshrc", root)).toBe("~/.zshrc");
    },
  );

  it.each(["src/app.ts", "/tmp/report.md"])("preserves existing file paths: %s", (path) => {
    expect(expandHomeFilePath(path, "/Users/tommy/repo")).toBe(path);
  });

  it("routes a home path inside the workspace as a workspace file", () => {
    const root = "/Users/tommy/repo";
    expect(
      resolveWorkspaceRelativeFilePath(root, expandHomeFilePath("~/repo/src/app.ts", root)),
    ).toBe("src/app.ts");
  });
});

describe("fileRoutePathSegments", () => {
  it("round-trips workspace-relative and host paths through the route", () => {
    expect(fileRoutePathSegments("src/main.ts")).toEqual(["src", "main.ts"]);
    expect(fileRoutePathSegments("/tmp/t3-cleanup/report.md").join("/")).toBe(
      "/tmp/t3-cleanup/report.md",
    );
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
    // It is not under the project, so naming the project there would be a lie.
    expect(fileHeaderSubtitle("t3code", "/tmp/report.md")).toBe("/tmp");
  });

  it("shows only the project for a file at the workspace root", () => {
    expect(fileHeaderSubtitle("t3code", "README.md")).toBe("t3code");
  });
});
