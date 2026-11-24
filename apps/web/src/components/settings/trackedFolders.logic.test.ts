import { describe, expect, it } from "vite-plus/test";

import { resolveTrackedFolderInput, trackedFolderDisplayPath } from "./trackedFolders.logic";

describe("trackedFolderDisplayPath", () => {
  it.each([
    ["/work/app/api", "/work/app", "./api"],
    ["/work/app/packages/web", "/work/app/", "./packages/web"],
    ["/work/other", "/work/app", "/work/other"],
    ["/work/app-two", "/work/app", "/work/app-two"],
    ["C:\\Work\\App\\api", "c:\\work\\app", "./api"],
  ])("shows %s under %s as %s", (path, root, expected) => {
    expect(trackedFolderDisplayPath(path, root)).toBe(expected);
  });
});

describe("resolveTrackedFolderInput", () => {
  const overflowingPath = `/srv/${"a".repeat(127)}🚀`;
  const paddedPath = `/srv/${" ".repeat(127)}🚀`;

  it.each([
    [
      "an absolute path that is not listed",
      { query: "/srv/repos/tools/", listedDirectoryPath: null, exactEntryPath: null },
      { path: "/srv/repos/tools", name: "tools" },
    ],
    [
      "a listed directory, which resolves the home prefix",
      { query: "~/code/", listedDirectoryPath: "/home/me/code", exactEntryPath: null },
      { path: "/home/me/code", name: "code" },
    ],
    [
      "an exact entry of the listed directory",
      {
        query: "~/code/tools",
        listedDirectoryPath: "/home/me/code",
        exactEntryPath: "/home/me/code/tools",
      },
      { path: "/home/me/code/tools", name: "tools" },
    ],
    [
      "an emoji crossing the name limit",
      { query: overflowingPath, listedDirectoryPath: null, exactEntryPath: null },
      { path: overflowingPath, name: "a".repeat(127) },
    ],
    [
      "an emoji after leading whitespace at the name limit",
      { query: paddedPath, listedDirectoryPath: null, exactEntryPath: null },
      { path: paddedPath, name: "🚀" },
    ],
    [
      "a directory name longer than a folder name may be",
      {
        query: `/srv/${"n".repeat(127)} ${"x".repeat(40)}`,
        listedDirectoryPath: null,
        exactEntryPath: null,
      },
      { path: `/srv/${"n".repeat(127)} ${"x".repeat(40)}`, name: "n".repeat(127) },
    ],
  ])("resolves %s", (_label, input, expected) => {
    expect(resolveTrackedFolderInput(input)).toEqual(expected);
  });

  it.each(["", "   ", "~/code/too", "relative/path"])("rejects %j without a listing", (query) => {
    expect(
      resolveTrackedFolderInput({ query, listedDirectoryPath: null, exactEntryPath: null }),
    ).toBeNull();
  });
});
