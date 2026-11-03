import { describe, expect, it } from "vite-plus/test";
import { parseFileUrlHref, splitFilePathPosition, resolvePathLinkTarget } from "./fileLinks.ts";

describe("parseFileUrlHref", () => {
  it.each([
    [
      "file:///D:/Programme/t3code/OpenInPicker.tsx#L69",
      "D:/Programme/t3code/OpenInPicker.tsx",
      "#L69",
    ],
    ["file://server/share/workspace-image.svg", "\\\\server\\share\\workspace-image.svg", ""],
    ["file://localhost/home/me/notes.md", "/home/me/notes.md", ""],
  ])("parses %s", (href, path, hash) => {
    expect(parseFileUrlHref(href)).toEqual({ path, hash });
  });

  it("keeps percent-encoding so the caller decodes once", () => {
    expect(parseFileUrlHref("file:///Users/julius/project/file%2520name.md")?.path).toBe(
      "/Users/julius/project/file%2520name.md",
    );
    expect(parseFileUrlHref("file:///c%3A/Users/x/shot.png")?.path).toBe("/c%3A/Users/x/shot.png");
  });

  it.each(["https://example.com/a.ts", "file://%", "/Users/julius/a.ts"])("rejects %s", (href) => {
    expect(parseFileUrlHref(href)).toBeNull();
  });
});

describe("splitFilePathPosition", () => {
  it.each([
    ["src/main.ts:12:5", "", { path: "src/main.ts", line: 12, column: 5 }],
    ["src/main.ts", "#L18C2", { path: "src/main.ts", line: 18, column: 2 }],
    ["src/main.ts:3", "#L18C2", { path: "src/main.ts", line: 3 }],
    ["src/main.ts:0", "", { path: "src/main.ts" }],
  ])("splits %s%s", (path, hash, expected) => {
    expect(splitFilePathPosition(path, hash)).toEqual(expected);
  });
});

describe("resolvePathLinkTarget", () => {
  // regression: #21199 Windows terminal file links resolve against a Windows cwd
  it.each([
    [
      String.raw`src\index.ts:12:7`,
      String.raw`C:\Users\Jane Doe\project`,
      String.raw`C:\Users\Jane Doe\project\src\index.ts:12:7`,
    ],
    [
      String.raw`.\src\index.ts:12`,
      String.raw`\\server\share\project`,
      String.raw`\\server\share\project\.\src\index.ts:12`,
    ],
    ["src/index.ts:12", "/home/jane/project", "/home/jane/project/src/index.ts:12"],
  ])("resolves %s using the connected environment cwd %s", (path, cwd, expected) => {
    expect(resolvePathLinkTarget(path, cwd)).toBe(expected);
  });

  it("keeps Windows absolute paths with forward slashes unchanged", () => {
    expect(
      resolvePathLinkTarget("C:/Users/julius/project/src/main.ts:12", "C:\\Users\\julius\\project"),
    ).toBe("C:/Users/julius/project/src/main.ts:12");
  });

  // regression: #19627 Windows home paths match case-insensitively
  it.each([
    ["C:\\users\\alice\\project", "C:\\users\\alice\\notes.md:3"],
    ["C:/uSeRs/alice/project", "C:/uSeRs/alice\\notes.md:3"],
  ])("resolves home paths against the Windows cwd %s", (cwd, expected) => {
    expect(resolvePathLinkTarget("~/notes.md:3", cwd)).toBe(expected);
  });
  it("keeps home paths unchanged when no supported home can be inferred", () => {
    for (const cwd of ["C:/work/project", "/Home/alice/project", "/users/alice/project"]) {
      expect(resolvePathLinkTarget("~/notes.md:3", cwd)).toBe("~/notes.md:3");
    }
  });
});
