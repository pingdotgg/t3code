import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildFileLinkParentSuffixByPath,
  fileLinkLabel,
  parseFileUrlHref,
  splitFilePathPosition,
  resolvePathLinkTarget,
} from "./fileLinks.ts";

describe("buildFileLinkParentSuffixByPath", () => {
  it.each([
    {
      paths: ["", "/", "index.ts", "/repo/src/index.ts"],
      suffixes: [["/repo/src/index.ts", "repo/src"]],
    },
    { paths: ["/repo/a.ts", "/repo/b.ts", "/repo/a.ts"], suffixes: [] },
    {
      paths: ["/repo/src/index.ts", "/repo/test/index.ts"],
      suffixes: [
        ["/repo/src/index.ts", "repo/src"],
        ["/repo/test/index.ts", "repo/test"],
      ],
    },
    {
      paths: ["/repo/a/src/index.ts", "/repo/b/src/index.ts"],
      suffixes: [
        ["/repo/a/src/index.ts", "a/src"],
        ["/repo/b/src/index.ts", "b/src"],
      ],
    },
    {
      paths: ["/a/pkg/src/index.ts", "/b/pkg/src/index.ts"],
      suffixes: [
        ["/a/pkg/src/index.ts", "a/pkg/src"],
        ["/b/pkg/src/index.ts", "b/pkg/src"],
      ],
    },
    {
      paths: ["src/index.ts", "/repo/src/index.ts"],
      suffixes: [
        ["src/index.ts", "src"],
        ["/repo/src/index.ts", "repo/src"],
      ],
    },
    {
      paths: ["/repo//src/index.ts", "/repo/src/index.ts"],
      suffixes: [
        ["/repo//src/index.ts", "repo/src"],
        ["/repo/src/index.ts", "repo/src"],
      ],
    },
    { paths: [String.raw`C:\repo\src\index.ts`, "C:/repo/src/index.ts"], suffixes: [] },
    {
      paths: [String.raw`C:\repo\src\index.ts`, String.raw`D:\repo\src\index.ts`],
      suffixes: [
        ["C:/repo/src/index.ts", "C:/repo/src"],
        ["D:/repo/src/index.ts", "D:/repo/src"],
      ],
    },
    {
      paths: [String.raw`\\one\share\src\index.ts`, String.raw`\\two\share\src\index.ts`],
      suffixes: [
        ["//one/share/src/index.ts", "one/share/src"],
        ["//two/share/src/index.ts", "two/share/src"],
      ],
    },
  ])("preserves suffixes for $paths", ({ paths, suffixes }) => {
    expect([...buildFileLinkParentSuffixByPath(paths)]).toEqual(suffixes);
  });

  it("bounds suffix construction by path count for a same-basename group", () => {
    const paths = Array.from({ length: 128 }, (_, i) => `/repo/packages/pkg-${i}/src/index.ts`);
    using joins = vi.spyOn(Array.prototype, "join");
    const result = buildFileLinkParentSuffixByPath(paths);
    const suffixConstructions = joins.mock.calls.length;

    expect(result).toEqual(new Map(paths.map((path, i) => [path, `pkg-${i}/src`])));
    // Count work instead of elapsed time so a pairwise scan fails on every machine.
    expect(suffixConstructions).toBeLessThan(paths.length * 20);
  });
});

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

  it("rejects one-letter schemes that Chromium on Windows reads as drive letters", () => {
    const NativeURL = URL;
    using _url = vi.spyOn(globalThis, "URL").mockImplementation(function (input: string | URL) {
      const drive = /^([a-z]):/i.exec(String(input));
      return drive
        ? new NativeURL(`file:///${drive[1]!.toUpperCase()}:/${String(input).slice(2)}`)
        : new NativeURL(input);
    });
    expect(parseFileUrlHref("d:x")).toBeNull();
  });
});

describe("splitFilePathPosition", () => {
  it.each([
    ["src/main.ts:12:5", "", { path: "src/main.ts", line: 12, column: 5 }],
    ["src/main.ts", "#L18C2", { path: "src/main.ts", line: 18, column: 2 }],
    ["src/main.ts:3", "#L18C2", { path: "src/main.ts", line: 3 }],
    ["src/main.ts:0", "", { path: "src/main.ts" }],
    ["src/main.ts:42-64", "", { path: "src/main.ts", line: 42, endLine: 64 }],
    ["src/main.ts", "#L42-L64", { path: "src/main.ts", line: 42, endLine: 64 }],
    ["src/main.ts:42-42", "", { path: "src/main.ts", line: 42 }],
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
    ["./reports/draft.md:2", "/home/jane/project", "/home/jane/project/reports/draft.md:2"],
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

describe("fileLinkLabel", () => {
  it.each([
    [{ path: "/repo/src/http.ts", line: 42, column: 7 }, "http.ts · L42:C7"],
    [{ path: "/repo/src/http.ts", line: 42, endLine: 64 }, "http.ts · L42–64"],
  ])("labels %o", (file, label) => {
    expect(fileLinkLabel(file, new Map())).toBe(label);
  });
});
