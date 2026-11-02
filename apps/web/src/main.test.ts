import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ render: vi.fn().mockName("root.render") }));

vi.mock("@fontsource-variable/inter", () => ({}));
vi.mock("./index.css", () => ({}));
vi.mock("./cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("./env", () => ({ isElectron: false }));
vi.mock("./appInit", () => ({ startAppServices: () => ({ load: () => Promise.resolve() }) }));
vi.mock("./AppRoot", () => ({ AppRoot: () => null }));
vi.mock("react-dom/client", () => ({
  default: { createRoot: () => ({ render: mocks.render }) },
}));

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

// Boots main in a fresh page that shares the tab's sessionStorage, as a reload does.
async function bootPage(storage: Storage) {
  vi.resetModules();
  mocks.render.mockClear();
  const reload = vi.fn().mockName("location.reload");
  const page = Object.assign(new EventTarget(), {
    sessionStorage: storage,
    location: { reload },
  });
  vi.unstubAllGlobals();
  vi.stubGlobal("window", page);
  vi.stubGlobal("document", { getElementById: () => ({}) });
  const { startup } = await import("./main");
  await startup;
  const failLazyChunk = () => {
    const event = Object.assign(new Event("vite:preloadError", { cancelable: true }), {
      payload: new TypeError("Failed to fetch dynamically imported module: /assets/highlights.js"),
    });
    page.dispatchEvent(event);
    return event;
  };
  return { reload, failLazyChunk };
}

describe("main chunk reload guard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reloads once, not on every visit, when a lazy chunk fails after each boot", async () => {
    const storage = createStorageStub();

    const firstVisit = await bootPage(storage);
    expect(mocks.render).toHaveBeenCalledTimes(1);
    expect(firstVisit.failLazyChunk().defaultPrevented).toBe(true);
    expect(firstVisit.reload).toHaveBeenCalledTimes(1);

    const afterReload = await bootPage(storage);
    expect(mocks.render).toHaveBeenCalledTimes(1);
    const repeat = afterReload.failLazyChunk();
    expect(afterReload.reload).not.toHaveBeenCalled();
    // Not prevented, so the import rejects and the code block falls back to plain text.
    expect(repeat.defaultPrevented).toBe(false);
  });
});
