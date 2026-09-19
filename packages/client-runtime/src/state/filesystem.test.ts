import { describe, expect, it } from "vite-plus/test";

import {
  canPreloadBrowsePath,
  createBrowseNavigationCoordinator,
  describeDrive,
  filterFilesystemBrowseEntries,
  formatDriveBytes,
  getFilesystemBrowsePath,
  shouldSkipDrivePicker,
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

  it("describes drives with free space when known", () => {
    expect(formatDriveBytes(0)).toBe("0 B");
    expect(formatDriveBytes(512)).toBe("512 B");
    expect(formatDriveBytes(1_500_000)).toBe("1.5 MB");
    expect(formatDriveBytes(412_000_000_000)).toBe("412 GB");
    expect(formatDriveBytes(2_000_000_000_000)).toBe("2.0 TB");
    expect(
      describeDrive({
        path: "/Volumes/External",
        label: "External",
        kind: "fixed",
        totalBytes: 2_000_000_000_000,
        freeBytes: 412_000_000_000,
      }),
    ).toBe("412 GB free of 2.0 TB · /Volumes/External");
    expect(
      describeDrive({
        path: "D:\\",
        label: "Data (D:)",
        kind: "fixed",
        totalBytes: null,
        freeBytes: null,
      }),
    ).toBe("D:\\");
    expect(
      describeDrive({
        path: "/mnt/data",
        label: "data",
        kind: "fixed",
        totalBytes: 2_000_000_000_000,
        freeBytes: 412_000_000_000,
        writable: false,
      }),
    ).toBe("412 GB free of 2.0 TB · /mnt/data · not writable");
  });

  it("skips the drive picker only when there is no extra volume", () => {
    const system = {
      path: "/",
      label: "System",
      kind: "system" as const,
      totalBytes: null,
      freeBytes: null,
    };
    const extra = {
      path: "D:\\",
      label: "Data (D:)",
      kind: "fixed" as const,
      totalBytes: null,
      freeBytes: null,
    };
    expect(shouldSkipDrivePicker([])).toBe(true);
    expect(shouldSkipDrivePicker([system])).toBe(true);
    expect(shouldSkipDrivePicker([extra])).toBe(false);
    expect(shouldSkipDrivePicker([system, extra])).toBe(false);
  });
});
