import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ showBootError: vi.fn().mockName("showBootError") }));

vi.mock("./lib/bootError", () => ({ showBootError: mocks.showBootError }));

// Mirrors Vite's build preload helper when main's CSS or JS chunk fails to load.
vi.mock("./main", () => {
  const error = new TypeError("Failed to fetch dynamically imported module: /assets/main.js");
  const event = Object.assign(new Event("vite:preloadError", { cancelable: true }), {
    payload: error,
  });
  window.dispatchEvent(event);
  throw error;
});

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

async function bootWithFailingMainChunk(storage: Storage) {
  vi.resetModules();
  mocks.showBootError.mockClear();
  const reload = vi.fn().mockName("location.reload");
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), { sessionStorage: storage, location: { reload } }),
  );
  try {
    const { boot } = await import("./bootstrap");
    await boot;
    return { reload, showBootError: mocks.showBootError };
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("bootstrap", () => {
  it("reloads once instead of showing the boot error when the main chunk fails to load", async () => {
    const { reload, showBootError } = await bootWithFailingMainChunk(createStorageStub());

    expect(reload).toHaveBeenCalledTimes(1);
    expect(showBootError).not.toHaveBeenCalled();
  });

  it("shows the boot error when the main chunk fails again after the reload", async () => {
    const { reload, showBootError } = await bootWithFailingMainChunk(
      createStorageStub({ "t3code:chunk-load-reloaded": "1" }),
    );

    expect(reload).not.toHaveBeenCalled();
    expect(showBootError).toHaveBeenCalledTimes(1);
  });
});
