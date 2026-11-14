import { describe, expect, it, vi } from "vite-plus/test";

import { isChunkLoadError, reloadOnceForChunkLoadError } from "./chunkReloadGuard";

function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

describe("reloadOnceForChunkLoadError", () => {
  it("reloads on the first failure and lets the second one surface", () => {
    const storage = createStorageStub();
    const reload = vi.fn();

    expect(reloadOnceForChunkLoadError(() => storage, reload, "1.0.0")).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    expect(reloadOnceForChunkLoadError(() => storage, reload, "1.0.0")).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads again once a deploy changed the build", () => {
    const storage = createStorageStub();
    const reload = vi.fn();

    reloadOnceForChunkLoadError(() => storage, reload, "1.0.0");

    expect(reloadOnceForChunkLoadError(() => storage, reload, "1.0.1")).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("never reloads when storage is blocked, so a persistent failure cannot loop", () => {
    const reload = vi.fn();
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };

    expect(reloadOnceForChunkLoadError(blocked, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("isChunkLoadError", () => {
  it.each([
    ["Failed to fetch dynamically imported module: t3code://app/assets/a.js", true],
    ["error loading dynamically imported module: https://app.t3.codes/assets/a.js", true],
    ["Importing a module script failed.", true],
    ["Cannot read properties of undefined", false],
  ])("%s", (message, expected) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(expected);
  });
});
