import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const expoModulesCoreMocks = vi.hoisted(() => ({
  requireNativeViewManager: vi.fn(),
}));
const nativeView = () => null;
const originalExpo = globalThis.expo;

function setExpoViewConfigAvailable() {
  globalThis.expo = {
    getViewConfig: vi.fn().mockReturnValue({ validAttributes: {}, directEventTypes: {} }),
  } as unknown as typeof globalThis.expo;
}

vi.mock("expo-modules-core", () => ({
  requireNativeViewManager: expoModulesCoreMocks.requireNativeViewManager,
}));

describe("resolveNativeReviewDiffView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    globalThis.expo = undefined as unknown as typeof globalThis.expo;
  });

  afterEach(() => {
    globalThis.expo = originalExpo;
  });

  it("returns null when the native review diff view config is unavailable", async () => {
    const { resolveNativeReviewDiffView } = await import("./nativeReviewDiffSurface");
    expect(resolveNativeReviewDiffView()).toBeNull();
    expect(expoModulesCoreMocks.requireNativeViewManager).not.toHaveBeenCalled();
  });

  it("returns the native review diff view when the view config is installed", async () => {
    setExpoViewConfigAvailable();
    expoModulesCoreMocks.requireNativeViewManager.mockReturnValue(nativeView);
    const { resolveNativeReviewDiffView } = await import("./nativeReviewDiffSurface");
    expect(resolveNativeReviewDiffView()).toBe(nativeView);
    expect(expoModulesCoreMocks.requireNativeViewManager).toHaveBeenCalledWith(
      "T3ReviewDiffSurface",
    );
  });

  it("does not fall back to stale legacy native review diff view names", async () => {
    globalThis.expo = {
      getViewConfig: vi.fn().mockImplementation((moduleName: string) => {
        if (moduleName === "T3ReviewDiffView") {
          return { validAttributes: {}, directEventTypes: {} };
        }
        return null;
      }),
    } as unknown as typeof globalThis.expo;
    expoModulesCoreMocks.requireNativeViewManager.mockReturnValue(nativeView);
    const { resolveNativeReviewDiffView } = await import("./nativeReviewDiffSurface");
    expect(resolveNativeReviewDiffView()).toBeNull();
    expect(expoModulesCoreMocks.requireNativeViewManager).not.toHaveBeenCalled();
  });

  it("returns null when the view manager cannot be required", async () => {
    setExpoViewConfigAvailable();
    expoModulesCoreMocks.requireNativeViewManager.mockImplementation(() => {
      throw new Error("boom");
    });
    const { resolveNativeReviewDiffView } = await import("./nativeReviewDiffSurface");
    expect(resolveNativeReviewDiffView()).toBeNull();
  });
});
