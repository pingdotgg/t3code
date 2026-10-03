import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const secureStore = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    read: (key: string) => values.get(key) ?? null,
    getItemAsync: vi.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
    setItemAsync: vi.fn((key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    }),
    deleteItemAsync: vi.fn((key: string) => {
      values.delete(key);
      return Promise.resolve();
    }),
  };
});

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: secureStore.deleteItemAsync,
  getItemAsync: secureStore.getItemAsync,
  setItemAsync: secureStore.setItemAsync,
}));

import {
  expandedPathAncestors,
  fileTreeExpansionKey,
  loadPersistedExpandedPaths,
  readCachedExpandedPaths,
  sanitizeExpandedPaths,
  savePersistedExpandedPaths,
  sortExpandedPathsParentFirst,
} from "./fileTreeExpansionPersistence";

beforeEach(() => {
  secureStore.clear();
  secureStore.getItemAsync.mockClear();
  secureStore.setItemAsync.mockClear();
});

describe("mobile file tree expansion persistence", () => {
  it("keys storage by environment and cwd", () => {
    const key = fileTreeExpansionKey("env-1", "/workspace");
    expect(key).toBe("t3code.fileTreeExpanded.env-1__2f_workspace");
    expect(fileTreeExpansionKey("env-1", "/other")).not.toBe(key);
    expect(fileTreeExpansionKey("env-2", "/workspace")).not.toBe(key);
  });

  it("keeps delimiter-containing workspaces on distinct keys", () => {
    // Plain concatenation maps both of these onto "...:a:b:c" and would share
    // their expanded state.
    expect(fileTreeExpansionKey("a", "b:c")).not.toBe(fileTreeExpansionKey("a:b", "c"));
    // "_" is the separator, so a literal underscore must not be able to pose
    // as one.
    expect(fileTreeExpansionKey("a_b", "c")).not.toBe(fileTreeExpansionKey("a", "b_c"));
  });

  it("builds keys SecureStore accepts", () => {
    // expo-secure-store rejects any key outside /^[\w.-]+$/, so an unescaped
    // environment id or absolute path makes every write fail.
    const key = fileTreeExpansionKey("env:with:colons", "/home/user/my repo (copy)/ünïcode");
    expect(key).toMatch(/^[\w.-]+$/);
    expect(fileTreeExpansionKey("env-1", "/workspace")).toMatch(/^[\w.-]+$/);
  });

  it("sanitizes stored lists", () => {
    expect(sanitizeExpandedPaths(["src", 42, "", "src", null])).toEqual(["src"]);
    expect(sanitizeExpandedPaths({ paths: ["src"] })).toEqual([]);
    expect(sanitizeExpandedPaths(null)).toEqual([]);
  });

  it("sorts parents before children", () => {
    expect(sortExpandedPathsParentFirst(["apps/web/src", "apps", "apps/web"])).toEqual([
      "apps",
      "apps/web",
      "apps/web/src",
    ]);
  });

  it("lists ancestor paths root-first including the directory itself", () => {
    expect(expandedPathAncestors("apps/web")).toEqual(["apps", "apps/web"]);
    expect(expandedPathAncestors("apps")).toEqual(["apps"]);
  });

  it("saves parent-first and reads back from the synchronous cache", async () => {
    const key = fileTreeExpansionKey("env-cache", "/workspace");
    expect(readCachedExpandedPaths(key)).toBeNull();
    expect(readCachedExpandedPaths(null)).toBeNull();

    savePersistedExpandedPaths(key, new Set(["apps/web", "apps"]));
    expect(readCachedExpandedPaths(key)).toEqual(["apps", "apps/web"]);
    // Saving is a no-op without a key.
    savePersistedExpandedPaths(null, new Set(["apps"]));

    await vi.waitFor(() => {
      expect(secureStore.setItemAsync).toHaveBeenCalledWith(key, '["apps","apps/web"]');
    });
  });

  it("loads from SecureStore on a cold cache and ignores corrupt values", async () => {
    const key = fileTreeExpansionKey("env-disk", "/workspace");
    secureStore.setItemAsync.mockClear();
    await secureStore.setItemAsync(key, JSON.stringify(["src", "src/components"]));

    // A different key keeps a cold cache so SecureStore is actually read.
    expect(secureStore.read(key)).not.toBeNull();
    const loaded = await loadPersistedExpandedPaths(key);
    expect(loaded).toEqual(["src", "src/components"]);
    expect(secureStore.getItemAsync).toHaveBeenCalledWith(key);
    // The disk read populates the synchronous cache for remounts.
    expect(readCachedExpandedPaths(key)).toEqual(["src", "src/components"]);

    const corruptKey = fileTreeExpansionKey("env-corrupt", "/workspace");
    await secureStore.setItemAsync(corruptKey, "{not json");
    await expect(loadPersistedExpandedPaths(corruptKey)).resolves.toEqual([]);
  });

  it("prefers the memory cache over SecureStore once warmed", async () => {
    const key = fileTreeExpansionKey("env-warm", "/workspace");
    savePersistedExpandedPaths(key, ["warm"]);
    secureStore.getItemAsync.mockClear();
    await expect(loadPersistedExpandedPaths(key)).resolves.toEqual(["warm"]);
    expect(secureStore.getItemAsync).not.toHaveBeenCalled();
  });

  it("keeps a save that lands while the disk read is in flight", async () => {
    const key = fileTreeExpansionKey("env-race", "/workspace");
    await secureStore.setItemAsync(key, JSON.stringify(["stale"]));
    let releaseRead: (() => void) | undefined;
    secureStore.getItemAsync.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          releaseRead = () => resolve(JSON.stringify(["stale"]));
        }),
    );
    const pendingRead = loadPersistedExpandedPaths(key);
    // The user toggles a folder while SecureStore is still answering.
    savePersistedExpandedPaths(key, ["fresh"]);
    releaseRead?.();
    await expect(pendingRead).resolves.toEqual(["fresh"]);
    expect(readCachedExpandedPaths(key)).toEqual(["fresh"]);
  });
});
