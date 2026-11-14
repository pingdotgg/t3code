import { describe, expect, it } from "vite-plus/test";

import {
  filterScannedFolders,
  mergeScannedTrackedFolders,
  resolveTrackedFolderInput,
  trackedFolderDisplayPath,
  untrackedScannedPaths,
} from "./TrackedFoldersDialog.logic";

const scanned = (path: string, name: string) => ({
  path,
  name,
  isGitRepository: true,
  source: "child" as const,
});

describe("trackedFolderDisplayPath", () => {
  it.each([
    ["/work/app/api", "/work/app", "api"],
    ["/work/app/packages/web", "/work/app/", "packages/web"],
    ["/work/other", "/work/app", "/work/other"],
    ["/work/app-two", "/work/app", "/work/app-two"],
    ["C:\\Work\\App\\api", "c:\\work\\app", "api"],
  ])("shows %s under %s as %s", (path, root, expected) => {
    expect(trackedFolderDisplayPath(path, root)).toBe(expected);
  });
});

describe("mergeScannedTrackedFolders", () => {
  const api = scanned("/work/app/api", "api");
  const web = scanned("/work/app/web", "web");
  const docs = scanned("/work/app/docs", "docs");

  it("keeps tracked folders the scan did not return and appends newly checked ones", () => {
    expect(
      mergeScannedTrackedFolders({
        tracked: [
          { path: "/elsewhere/shared", name: "shared" },
          { path: "/work/app/api", name: "API service" },
          { path: "/work/app/web", name: "web" },
        ],
        scanned: [api, web, docs],
        checked: [api, docs],
      }),
    ).toEqual([
      { path: "/elsewhere/shared", name: "shared" },
      { path: "/work/app/api", name: "API service" },
      { path: "/work/app/docs", name: "docs" },
    ]);
  });

  it("matches Windows paths without regard to case or separator", () => {
    const windowsApi = scanned("C:\\Work\\App\\api", "api");
    expect(
      mergeScannedTrackedFolders({
        tracked: [{ path: "c:/work/app/api", name: "api" }],
        scanned: [windowsApi],
        checked: [windowsApi],
      }),
    ).toEqual([{ path: "c:/work/app/api", name: "api" }]);
  });
});

describe("untrackedScannedPaths", () => {
  it("returns the scanned paths that are not tracked yet", () => {
    expect([
      ...untrackedScannedPaths(
        [{ path: "/work/app/api", name: "api" }],
        [scanned("/work/app/api", "api"), scanned("/work/app/web", "web")],
      ),
    ]).toEqual(["/work/app/web"]);
  });
});

describe("filterScannedFolders", () => {
  it("matches the name or the path, ignoring case", () => {
    const folders = [scanned("/work/app/api", "API"), scanned("/work/libs/web", "web")];
    expect(filterScannedFolders(folders, " api ")).toEqual([folders[0]]);
    expect(filterScannedFolders(folders, "LIBS")).toEqual([folders[1]]);
    expect(filterScannedFolders(folders, "")).toBe(folders);
  });
});

describe("resolveTrackedFolderInput", () => {
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
  ])("resolves %s", (_label, input, expected) => {
    expect(resolveTrackedFolderInput(input)).toEqual(expected);
  });

  it.each(["", "   ", "~/code/too", "relative/path"])("rejects %j without a listing", (query) => {
    expect(
      resolveTrackedFolderInput({ query, listedDirectoryPath: null, exactEntryPath: null }),
    ).toBeNull();
  });
});
