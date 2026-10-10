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

const BUILD_A = "https://app.t3.codes/assets/index-A.js";
const BUILD_B = "https://app.t3.codes/assets/index-B.js";
const failedImport = (asset: string) =>
  `TypeError: Failed to fetch dynamically imported module: https://app.t3.codes/assets/${asset}`;

describe("reloadOnceForChunkLoadError", () => {
  it("reloads once for a chunk that fails on every boot, then lets it surface", () => {
    const storage = createStorageStub();
    const reload = vi.fn();

    expect(
      reloadOnceForChunkLoadError(BUILD_B, failedImport("chat-1.js"), () => storage, reload),
    ).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    // Every later boot requests the same failing chunk during its first render.
    expect(
      reloadOnceForChunkLoadError(BUILD_B, failedImport("chat-1.js"), () => storage, reload),
    ).toBe(false);
    expect(
      reloadOnceForChunkLoadError(BUILD_B, failedImport("chat-1.js"), () => storage, reload),
    ).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads for each deploy that fails a chunk, however soon after the last reload", () => {
    const storage = createStorageStub();
    const reload = vi.fn();

    // Deploy B fails a chunk of the open build, then deploy C, seconds later,
    // fails a chunk of the build B reload loaded.
    expect(
      reloadOnceForChunkLoadError(BUILD_A, failedImport("settings-a.js"), () => storage, reload),
    ).toBe(true);
    expect(
      reloadOnceForChunkLoadError(BUILD_B, failedImport("diff-b.js"), () => storage, reload),
    ).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);

    // A chunk of build B that keeps failing still stops after its one reload.
    expect(
      reloadOnceForChunkLoadError(BUILD_B, failedImport("diff-b.js"), () => storage, reload),
    ).toBe(false);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("stops reloading once a build has used its reloads", () => {
    const storage = createStorageStub();
    const reload = vi.fn();

    for (let index = 0; index < 20; index += 1) {
      reloadOnceForChunkLoadError(
        BUILD_B,
        failedImport(`chunk-${index}.js`),
        () => storage,
        reload,
      );
    }

    expect(
      reloadOnceForChunkLoadError(BUILD_B, failedImport("chunk-20.js"), () => storage, reload),
    ).toBe(false);
    expect(reload).toHaveBeenCalledTimes(20);
  });

  it("gives each new build its own reloads, however many earlier builds used", () => {
    const storage = createStorageStub();
    const reload = vi.fn();

    for (let index = 0; index < 20; index += 1) {
      reloadOnceForChunkLoadError(
        BUILD_A,
        failedImport(`chunk-${index}.js`),
        () => storage,
        reload,
      );
    }

    expect(
      reloadOnceForChunkLoadError(BUILD_B, failedImport("chunk-0.js"), () => storage, reload),
    ).toBe(true);
    expect(
      reloadOnceForChunkLoadError(BUILD_B, failedImport("chunk-0.js"), () => storage, reload),
    ).toBe(false);
    expect(reload).toHaveBeenCalledTimes(21);
  });

  it("never reloads when storage is blocked, so a persistent failure cannot loop", () => {
    const reload = vi.fn();
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };

    expect(reloadOnceForChunkLoadError(BUILD_B, failedImport("chat-1.js"), blocked, reload)).toBe(
      false,
    );
    expect(reload).not.toHaveBeenCalled();
  });
});
