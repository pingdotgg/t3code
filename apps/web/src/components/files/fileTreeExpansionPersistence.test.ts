// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  expandedPathAncestors,
  fileTreeExpansionStorageKey,
  pruneExpandedPaths,
  readPersistedExpandedPaths,
  sortExpandedPathsParentFirst,
  writePersistedExpandedPaths,
} from "./fileTreeExpansionPersistence";

const storageKey = fileTreeExpansionStorageKey("env-1", "/workspace");

beforeEach(() => {
  window.localStorage.clear();
});

describe("file tree expansion persistence", () => {
  it("keys storage by environment and cwd", () => {
    expect(storageKey).toBe("t3code.fileTreeExpanded.env-1__2f_workspace");
    expect(fileTreeExpansionStorageKey("env-1", "/other")).not.toBe(storageKey);
    expect(fileTreeExpansionStorageKey("env-2", "/workspace")).not.toBe(storageKey);
  });

  it("keeps delimiter-containing workspaces on distinct keys", () => {
    // Plain concatenation maps both of these onto "...:a:b:c" and would share
    // their expanded state.
    expect(fileTreeExpansionStorageKey("a", "b:c")).not.toBe(
      fileTreeExpansionStorageKey("a:b", "c"),
    );
    // "_" is the separator, so a literal underscore must not be able to pose
    // as one.
    expect(fileTreeExpansionStorageKey("a_b", "c")).not.toBe(
      fileTreeExpansionStorageKey("a", "b_c"),
    );
  });

  it("builds keys inside the character set both storages accept", () => {
    const key = fileTreeExpansionStorageKey("env:with:colons", "/home/user/my repo (copy)/ünïcode");
    expect(key).toMatch(/^[\w.-]+$/);
  });

  it("round-trips the expanded set and starts empty when missing", () => {
    expect(readPersistedExpandedPaths(storageKey)).toEqual([]);
    writePersistedExpandedPaths(storageKey, new Set(["apps/", "apps/web/"]));
    expect(readPersistedExpandedPaths(storageKey)).toEqual(["apps/", "apps/web/"]);
  });

  it("ignores corrupt or misshapen storage", () => {
    window.localStorage.setItem(storageKey, "{not json");
    expect(readPersistedExpandedPaths(storageKey)).toEqual([]);
    window.localStorage.setItem(storageKey, JSON.stringify({ paths: ["apps/"] }));
    expect(readPersistedExpandedPaths(storageKey)).toEqual([]);
    window.localStorage.setItem(storageKey, JSON.stringify(["apps/", 42, "", "apps/", null]));
    expect(readPersistedExpandedPaths(storageKey)).toEqual(["apps/"]);
  });

  it("sorts parents before children", () => {
    expect(sortExpandedPathsParentFirst(["apps/web/src/", "apps/", "apps/web/"])).toEqual([
      "apps/",
      "apps/web/",
      "apps/web/src/",
    ]);
  });

  it("lists ancestor tree paths root-first including the directory itself", () => {
    expect(expandedPathAncestors("apps/web/")).toEqual(["apps/", "apps/web/"]);
    expect(expandedPathAncestors("apps/")).toEqual(["apps/"]);
  });

  it("prunes paths that left the loaded directories", () => {
    expect(pruneExpandedPaths(["apps/", "gone/"], new Set(["apps/", "apps/web/"]))).toEqual([
      "apps/",
    ]);
  });
});
