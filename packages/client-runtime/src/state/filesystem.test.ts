import { describe, expect, it } from "vite-plus/test";

import {
  canPreloadBrowsePath,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "./filesystem.ts";

describe("filesystem browse model", () => {
  it("retains server matches spanning folders without confusing them with exact leaf names", () => {
    const match = {
      name: "makespace",
      fullPath: "/Workspace/makespace",
      searchMatch: { query: "wormak", score: 5200 },
    };
    expect(filterFilesystemBrowseEntries([match], "wormak")).toEqual({
      visibleEntries: [match],
      exactEntry: null,
    });
    expect(filterFilesystemBrowseEntries([match], "different").visibleEntries).toEqual([]);
    const literal = { name: "wormak", fullPath: "/wormak" };
    expect(filterFilesystemBrowseEntries([match, literal], "wormak")).toEqual({
      visibleEntries: [literal, match],
      exactEntry: literal,
    });
  });

  it("accepts unrooted search fragments only inside a folder picker with a base", () => {
    expect(getFilesystemBrowsePath("wor/mak").isBrowsing).toBe(false);
    expect(getFilesystemBrowsePath("wor/mak", "", true, "~/")).toEqual({
      isBrowsing: true,
      directoryPath: "~/wor/",
      filterQuery: "mak",
      parentPath: "~/",
      canBrowseUp: true,
    });
    expect(getFilesystemBrowsePath("my-project", "", true, "/projects").directoryPath).toBe(
      "/projects/",
    );
    expect(getFilesystemBrowsePath("/absolute/path", "", true, "~/").directoryPath).toBe(
      "/absolute/",
    );
    expect(getFilesystemBrowsePath("3D Scan", "", true, "~/").filterQuery).toBe("3D Scan");
    expect(getFilesystemBrowsePath("C:\\Users\\test", "MacIntel", true, "~/").isBrowsing).toBe(
      false,
    );
  });

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

  it("ranks exact names before prefixes, path words, substrings, and abbreviations", () => {
    const entries = ["t3-cool-dev", "myt3code", "my-t3code", "t3code-next", "t3code"].map(
      (name) => ({ name, fullPath: `/projects/${name}` }),
    );
    expect(
      filterFilesystemBrowseEntries(entries, "t3code").visibleEntries.map((entry) => entry.name),
    ).toEqual(["t3code", "t3code-next", "my-t3code", "myt3code", "t3-cool-dev"]);
    expect(filterFilesystemBrowseEntries(entries, "T3CD").visibleEntries[0]?.name).toBe("t3code");
  });

  it("finds mistyped folders without treating a suggestion as an exact path", () => {
    const entries = ["Downloads", "Workspace", ".workspace"].map((name) => ({
      name,
      fullPath: `/Users/test/${name}`,
    }));
    for (const query of ["wrkspc", "workspcae", "workspaxe", "worksspace"]) {
      expect(filterFilesystemBrowseEntries(entries, query)).toEqual({
        visibleEntries: [entries[1]],
        exactEntry: null,
      });
    }
    expect(filterFilesystemBrowseEntries(entries, "zzz").visibleEntries).toEqual([]);
    expect(filterFilesystemBrowseEntries(entries, ".wrk").visibleEntries).toEqual([entries[2]]);
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
