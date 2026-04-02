import { describe, expect, it } from "vitest";

import { getSafeOpenTarget, stripLocationSuffixFromLocalPath } from "./openTarget";

describe("stripLocationSuffixFromLocalPath", () => {
  it("expands the home directory prefix", () => {
    expect(
      stripLocationSuffixFromLocalPath("~/notes/today.md", {
        homeDir: "/Users/tester",
      }),
    ).toBe("/Users/tester/notes/today.md");
  });

  it("strips line and hash suffixes when the base path exists", () => {
    expect(
      stripLocationSuffixFromLocalPath("/Users/tester/notes/today.md:14#L14", {
        pathExists: (path) => path === "/Users/tester/notes/today.md",
      }),
    ).toBe("/Users/tester/notes/today.md");
  });

  it("keeps the original path when the suffixed path exists", () => {
    expect(
      stripLocationSuffixFromLocalPath("/Users/tester/notes/today.md:14", {
        pathExists: (path) => path === "/Users/tester/notes/today.md:14",
      }),
    ).toBe("/Users/tester/notes/today.md:14");
  });
});

describe("getSafeOpenTarget", () => {
  it("accepts absolute local paths", () => {
    expect(
      getSafeOpenTarget("/Users/tester/notes/today.md:14", {
        pathExists: (path) => path === "/Users/tester/notes/today.md",
      }),
    ).toEqual({
      kind: "path",
      value: "/Users/tester/notes/today.md",
    });
  });

  it("accepts file urls that point to local markdown files", () => {
    expect(
      getSafeOpenTarget("file:///Users/tester/notes/today.md:14", {
        pathExists: (path) => path === "/Users/tester/notes/today.md",
      }),
    ).toEqual({
      kind: "path",
      value: "/Users/tester/notes/today.md",
    });
  });

  it("accepts supported editor and app schemes", () => {
    expect(getSafeOpenTarget("zed://file/Users/tester/notes/today.md")).toEqual({
      kind: "external",
      value: "zed://file/Users/tester/notes/today.md",
    });
    expect(getSafeOpenTarget("obsidian://open?vault=notes&file=today")).toEqual({
      kind: "external",
      value: "obsidian://open?vault=notes&file=today",
    });
  });

  it("rejects unsupported schemes", () => {
    expect(getSafeOpenTarget("javascript:alert(1)")).toBeNull();
    expect(getSafeOpenTarget("ftp://example.com/file.md")).toBeNull();
  });
});
