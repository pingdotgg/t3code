import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  clearGuard: vi.fn(),
  reload: vi.fn(),
  alreadyReloaded: true,
  pathname: "/",
}));

vi.mock("react-dom/client", () => ({ default: { createRoot: () => ({ render: mocks.render }) } }));
vi.mock("./appInit", () => ({
  startAppServices: () => ({
    load: async () => {},
    state: { location: { pathname: mocks.pathname } },
  }),
}));
vi.mock("./AppRoot", () => ({ AppRoot: () => null }));
vi.mock("./cloud/publicConfig", () => ({ hasCloudPublicConfig: () => true }));
vi.mock("./env", () => ({ isElectron: false }));
vi.mock("./components/clerk/BrowserManagedAuthShell", () => ({ default: () => null }));
vi.mock("./lib/chunkReloadGuard", () => ({
  clearChunkReloadGuard: mocks.clearGuard,
  reloadOnceForChunkLoadError: () => {
    if (mocks.alreadyReloaded) return false;
    mocks.reload();
    return true;
  },
}));
vi.mock("./components/cloud/ConnectOnboardingDialog", () => {
  window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
  throw new Error("Dialog chunk unavailable");
});

it.each([true, false])(
  "keeps dialog failure out of startup after reload=%s",
  async (alreadyReloaded) => {
    vi.resetModules();
    mocks.render.mockClear();
    mocks.clearGuard.mockClear();
    mocks.reload.mockClear();
    mocks.alreadyReloaded = alreadyReloaded;
    mocks.pathname = "/";
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", { getElementById: () => ({}) });

    try {
      const { startup } = await import("./main");
      await expect(startup).resolves.toBeUndefined();
      await vi.dynamicImportSettled();
      expect(mocks.clearGuard).not.toHaveBeenCalled();
      if (alreadyReloaded) {
        expect(mocks.render).toHaveBeenCalledOnce();
        expect(mocks.reload).not.toHaveBeenCalled();
      } else {
        expect(mocks.reload).toHaveBeenCalledOnce();
      }
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  },
);

it.each(["/guest", "/pair", "/connect", "/connect-agent", "/welcome"])(
  "does not request the dialog or reload standalone route %s",
  async (pathname) => {
    vi.resetModules();
    mocks.render.mockClear();
    mocks.clearGuard.mockClear();
    mocks.reload.mockClear();
    mocks.alreadyReloaded = false;
    mocks.pathname = pathname;
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", { getElementById: () => ({}) });

    try {
      const { startup } = await import("./main");
      await expect(startup).resolves.toBeUndefined();
      await vi.dynamicImportSettled();
      expect(mocks.render).toHaveBeenCalledOnce();
      expect(mocks.clearGuard).toHaveBeenCalledOnce();
      expect(mocks.reload).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  },
);
