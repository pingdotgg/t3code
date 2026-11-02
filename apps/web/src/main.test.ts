import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  render: vi.fn().mockName("root.render"),
  // Runs while the router loads, before main decides whether to render.
  duringRouterLoad: (): void => {},
}));

vi.mock("@fontsource-variable/inter", () => ({}));
vi.mock("./index.css", () => ({}));
vi.mock("./cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("./env", () => ({ isElectron: false }));
vi.mock("./appInit", () => ({
  startAppServices: () => ({
    load: async () => {
      mocks.duringRouterLoad();
    },
  }),
}));
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

function failChunk(page: EventTarget) {
  const event = Object.assign(new Event("vite:preloadError", { cancelable: true }), {
    payload: new TypeError("Failed to fetch dynamically imported module: /assets/highlights.js"),
  });
  page.dispatchEvent(event);
  return event;
}

// Boots main in a fresh page that shares the tab's sessionStorage, as a reload does.
async function bootPage(storage: Storage, { failDuringBoot = false } = {}) {
  vi.resetModules();
  mocks.render.mockClear();
  const reload = vi.fn().mockName("location.reload");
  const page = Object.assign(new EventTarget(), {
    sessionStorage: storage,
    location: { reload },
  });
  mocks.duringRouterLoad = failDuringBoot ? () => void failChunk(page) : () => {};
  vi.unstubAllGlobals();
  vi.stubGlobal("window", page);
  vi.stubGlobal("document", { getElementById: () => ({}) });
  const { startup } = await import("./main");
  await startup;
  return { reload, failLazyChunk: () => failChunk(page) };
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

    for (let visit = 0; visit < 3; visit += 1) {
      const nextVisit = await bootPage(storage);
      expect(mocks.render).toHaveBeenCalledTimes(1);
      // Not prevented: the failed import rejects and the caller's error handling takes over.
      expect(nextVisit.failLazyChunk().defaultPrevented).toBe(false);
      expect(nextVisit.reload).not.toHaveBeenCalled();
    }
  });

  it("skips rendering when a chunk fails during boot and a reload is on its way", async () => {
    const { reload } = await bootPage(createStorageStub(), { failDuringBoot: true });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("renders when a chunk fails during boot after the build already reloaded", async () => {
    const storage = createStorageStub();
    await bootPage(storage, { failDuringBoot: true });

    const { reload } = await bootPage(storage, { failDuringBoot: true });

    expect(reload).not.toHaveBeenCalled();
    expect(mocks.render).toHaveBeenCalledTimes(1);
  });
});
