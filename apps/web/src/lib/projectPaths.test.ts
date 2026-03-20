import { describe, expect, it } from "vitest";

import {
  appendBrowsePathSegment,
  findProjectByPath,
  getBrowseParentPath,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isFilesystemBrowseQuery,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from "./projectPaths";

describe("projectPaths", () => {
  it("normalizes trailing separators for dispatch and comparison", () => {
    expect(normalizeProjectPathForDispatch(" /repo/app/ ")).toBe("/repo/app");
    expect(normalizeProjectPathForComparison("/repo/app/")).toBe("/repo/app");
  });

  it("normalizes windows-style paths for comparison", () => {
    expect(normalizeProjectPathForComparison("C:/Work/Repo/")).toBe("c:\\work\\repo");
    expect(normalizeProjectPathForComparison("C:\\Work\\Repo\\")).toBe("c:\\work\\repo");
  });

  it("finds existing projects even when the input formatting differs", () => {
    const existing = findProjectByPath(
      [
        { id: "project-1", cwd: "/repo/app" },
        { id: "project-2", cwd: "C:\\Work\\Repo" },
      ],
      "C:/Work/Repo/",
    );

    expect(existing?.id).toBe("project-2");
  });

  it("infers project titles from normalized paths", () => {
    expect(inferProjectTitleFromPath("/repo/app/")).toBe("app");
    expect(inferProjectTitleFromPath("C:\\Work\\Repo\\")).toBe("Repo");
  });

  it("detects browse queries across supported path styles", () => {
    expect(isFilesystemBrowseQuery("~/projects")).toBe(true);
    expect(isFilesystemBrowseQuery("..\\docs")).toBe(true);
    expect(isFilesystemBrowseQuery("notes")).toBe(false);
  });

  it("only treats windows-style paths as browse queries on windows", () => {
    expect(isFilesystemBrowseQuery("C:\\Work\\Repo\\", "MacIntel")).toBe(false);
    expect(isFilesystemBrowseQuery("C:\\Work\\Repo\\", "Win32")).toBe(true);
    expect(isUnsupportedWindowsProjectPath("C:\\Work\\Repo\\", "MacIntel")).toBe(true);
    expect(isUnsupportedWindowsProjectPath("C:\\Work\\Repo\\", "Win32")).toBe(false);
  });

  it("detects explicit relative project paths", () => {
    expect(isExplicitRelativeProjectPath("./docs")).toBe(true);
    expect(isExplicitRelativeProjectPath("..\\docs")).toBe(true);
    expect(isExplicitRelativeProjectPath("/repo/docs")).toBe(false);
  });

  it("resolves explicit relative paths against the current project", () => {
    expect(resolveProjectPathForDispatch("./docs", "/repo/app")).toBe("/repo/app/docs");
    expect(resolveProjectPathForDispatch("../docs", "/repo/app")).toBe("/repo/docs");
    expect(resolveProjectPathForDispatch("./Repo", "C:\\Work")).toBe("C:\\Work\\Repo");
  });

  it("navigates browse paths with matching separators", () => {
    expect(appendBrowsePathSegment("/repo/", "src")).toBe("/repo/src/");
    expect(appendBrowsePathSegment("C:\\Work\\", "Repo")).toBe("C:\\Work\\Repo\\");
    expect(getBrowseParentPath("/repo/src/")).toBe("/repo/");
    expect(getBrowseParentPath("C:\\Work\\Repo\\")).toBe("C:\\Work\\");
    expect(getBrowseParentPath("C:\\")).toBeNull();
  });
});
