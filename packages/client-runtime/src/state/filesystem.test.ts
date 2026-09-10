import { describe, expect, it } from "vite-plus/test";

import {
  canPreloadBrowsePath,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  getBrowseCreateDirectoryTarget,
  getFilesystemBrowsePath,
} from "./filesystem.ts";

describe("filesystem browse model", () => {
  it("derives the browse target and navigation state", () => {
    expect(getFilesystemBrowsePath("~/projects/t3")).toEqual({
      isBrowsing: true,
      directoryPath: "~/projects/",
      filterQuery: "t3",
      parentPath: "~/",
      canBrowseUp: true,
    });
    expect(getFilesystemBrowsePath("C:\\Users\\test", "MacIntel").isBrowsing).toBe(false);
    expect(getFilesystemBrowsePath("~/projects/", "", false).isBrowsing).toBe(false);
  });

  it("filters names, hidden directories, and exact matches consistently", () => {
    const entries = [
      { name: ".config", fullPath: "/Users/test/.config" },
      { name: "Code", fullPath: "/Users/test/Code" },
      { name: "codething", fullPath: "/Users/test/codething" },
    ];

    expect(filterFilesystemBrowseEntries(entries, "co")).toEqual({
      visibleEntries: entries.slice(1, 3),
      exactEntry: null,
    });
    expect(filterFilesystemBrowseEntries(entries, "").visibleEntries).toEqual(entries.slice(1));
    expect(filterFilesystemBrowseEntries(entries, ".").visibleEntries).toEqual(entries.slice(0, 1));
    expect(filterFilesystemBrowseEntries(entries, "Code").exactEntry).toEqual(entries[1]);
  });
});

describe("browse folder creation", () => {
  const entries = [
    { name: "Code", fullPath: "/Users/test/Code" },
    { name: "notes", fullPath: "/Users/test/notes" },
  ];
  const target = (leafName: string, caseSensitive = true) =>
    getBrowseCreateDirectoryTarget({
      directoryPath: "~/",
      leafName,
      entries,
      caseSensitive,
    });

  it("offers the typed name as a new child of the browsed directory", () => {
    expect(target("scratch")).toEqual({ parentPath: "~/", name: "scratch" });
    expect(target("  scratch  ")).toEqual({ parentPath: "~/", name: "scratch" });
  });

  it("does not offer a folder the listing already has", () => {
    expect(target("Code")).toBeNull();
    expect(target("code")).toEqual({ parentPath: "~/", name: "code" });
    expect(target("code", false)).toBeNull();
  });

  it("ignores names that are not a single new folder", () => {
    for (const name of ["", "   ", ".", "..", "a/b", "a\\b"]) {
      expect(target(name)).toBeNull();
    }
  });

  it("needs a browsed directory to create the folder in", () => {
    expect(
      getBrowseCreateDirectoryTarget({
        directoryPath: "",
        leafName: "scratch",
        entries: [],
        caseSensitive: true,
      }),
    ).toBeNull();
  });
});

describe("browse navigation", () => {
  it("only commits the latest valid navigation", async () => {
    const navigation = createBrowseNavigationCoordinator();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const commits: string[] = [];
    const commit = (name: string) => () => commits.push(name);
    const firstRun = navigation.run(() => first.promise, commit("first"));
    const secondRun = navigation.run(() => second.promise, commit("second"));

    second.resolve();
    await expect(secondRun).resolves.toBe(true);
    first.resolve();
    await expect(firstRun).resolves.toBe(false);

    const invalidated = Promise.withResolvers<void>();
    const invalidatedRun = navigation.run(() => invalidated.promise, commit("stale"));
    navigation.invalidate();
    invalidated.resolve();

    await expect(invalidatedRun).resolves.toBe(false);
    expect(commits).toEqual(["second"]);
  });

  it("only preloads connected environments", () => {
    expect(canPreloadBrowsePath("connected")).toBe(true);
    expect(canPreloadBrowsePath("offline")).toBe(false);
    expect(canPreloadBrowsePath("reconnecting")).toBe(false);
    expect(canPreloadBrowsePath(null)).toBe(false);
  });
});
