import { describe, expect, it, vi } from "vite-plus/test";

import { CHUNK_RELOAD_GUARD_WINDOW_MS, reloadOnceForChunkLoadError } from "./chunkReloadGuard";

function createStorageStub(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
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

function createClock(start = 1_800_000_000_000) {
  let time = start;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("reloadOnceForChunkLoadError", () => {
  it("reloads on the first failure and lets a repeat within the window surface", () => {
    const storage = createStorageStub();
    const clock = createClock();
    const reload = vi.fn();

    expect(reloadOnceForChunkLoadError(() => storage, reload, clock.now)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    clock.advance(1_000);
    expect(reloadOnceForChunkLoadError(() => storage, reload, clock.now)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("doesn't reload again when a lazy chunk fails after every boot", () => {
    const storage = createStorageStub();
    const clock = createClock();
    const reload = vi.fn();

    // Each visit boots fine, then fails to load the same lazy chunk about two seconds later.
    const reloads = Array.from({ length: 10 }, () => {
      clock.advance(2_000);
      return reloadOnceForChunkLoadError(() => storage, reload, clock.now);
    });

    expect(reloads.filter(Boolean)).toHaveLength(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads again once the window has passed, so a later deploy still recovers", () => {
    const storage = createStorageStub();
    const clock = createClock();
    const reload = vi.fn();

    reloadOnceForChunkLoadError(() => storage, reload, clock.now);
    clock.advance(CHUNK_RELOAD_GUARD_WINDOW_MS);

    expect(reloadOnceForChunkLoadError(() => storage, reload, clock.now)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("treats a guard written by an older version as expired", () => {
    const storage = createStorageStub({ "t3code:chunk-load-reloaded": "1" });
    const reload = vi.fn();

    expect(reloadOnceForChunkLoadError(() => storage, reload, createClock().now)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("doesn't reload when the clock moved backwards since the last reload", () => {
    const storage = createStorageStub();
    const clock = createClock();
    const reload = vi.fn();

    reloadOnceForChunkLoadError(() => storage, reload, clock.now);
    clock.advance(-60_000);

    expect(reloadOnceForChunkLoadError(() => storage, reload, clock.now)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
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
