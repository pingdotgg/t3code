import { describe, expect, it, vi } from "vite-plus/test";

import { reloadOnceForChunkLoadError } from "./chunkReloadGuard";

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

    expect(reloadOnceForChunkLoadError("a", "chunk", () => storage, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    expect(reloadOnceForChunkLoadError("a", "chunk", () => storage, reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("gives each build its own reload", () => {
    const storage = createStorageStub();
    const reload = vi.fn();

    reloadOnceForChunkLoadError("a", "chunk", () => storage, reload);

    expect(reloadOnceForChunkLoadError("b", "chunk", () => storage, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("bounds failures per build and resets the limit for the next build", () => {
    const storage = createStorageStub();
    const reload = vi.fn();
    for (const build of ["a", "b"]) {
      for (let index = 0; index < 20; index += 1) {
        expect(reloadOnceForChunkLoadError(build, String(index), () => storage, reload)).toBe(true);
      }
      expect(reloadOnceForChunkLoadError(build, "20", () => storage, reload)).toBe(false);
    }
    expect(reload).toHaveBeenCalledTimes(40);
  });

  it("never reloads when storage is blocked, so a persistent failure cannot loop", () => {
    const reload = vi.fn();
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };

    expect(reloadOnceForChunkLoadError("a", "chunk", blocked, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
