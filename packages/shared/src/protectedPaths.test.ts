import { describe, expect, it } from "vitest";

import {
  getProtectedAbsolutePaths,
  getProtectedDirectoryNames,
  isProtectedPath,
} from "./protectedPaths.ts";

describe("protectedPaths", () => {
  it("returns macOS protected home directory names and paths", () => {
    const home = "/Users/tester";

    expect(getProtectedDirectoryNames("darwin", home)).toEqual(
      new Set([
        "Music",
        "Pictures",
        "Movies",
        "Downloads",
        "Desktop",
        "Documents",
        "Public",
        "Applications",
        "Library",
      ]),
    );
    expect(getProtectedAbsolutePaths("darwin", home)).toContain("/Users/tester/Documents");
    expect(getProtectedAbsolutePaths("darwin", home)).toContain("/Users/tester/Library/Mail");
    expect(getProtectedAbsolutePaths("darwin", home)).toContain("/.Spotlight-V100");
  });

  it("returns Windows protected home directory names", () => {
    const home = "C:\\Users\\tester";

    expect(getProtectedDirectoryNames("win32", home)).toEqual(
      new Set([
        "AppData",
        "Downloads",
        "Desktop",
        "Documents",
        "Pictures",
        "Music",
        "Videos",
        "OneDrive",
      ]),
    );
  });

  it("returns no protected paths for Linux", () => {
    expect(getProtectedDirectoryNames("linux", "/home/tester").size).toBe(0);
    expect(getProtectedAbsolutePaths("linux", "/home/tester")).toEqual([]);
  });

  it("matches protected paths with normalization and nested paths", () => {
    const home = "/Users/tester";

    expect(
      isProtectedPath({ path: "/Users/tester/Documents/", platform: "darwin", homeDir: home }),
    ).toBe(true);
    expect(
      isProtectedPath({
        path: "/Users/tester/Documents/project/file.ts",
        platform: "darwin",
        homeDir: home,
      }),
    ).toBe(true);
    expect(
      isProtectedPath({ path: "/Users/tester/Code/project", platform: "darwin", homeDir: home }),
    ).toBe(false);
  });
});
