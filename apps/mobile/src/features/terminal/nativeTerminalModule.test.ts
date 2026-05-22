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

describe("resolveNativeTerminalSurfaceView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    globalThis.expo = undefined as unknown as typeof globalThis.expo;
  });

  afterEach(() => {
    globalThis.expo = originalExpo;
  });

  it("returns null when the native terminal view config is unavailable", async () => {
    const { resolveNativeTerminalSurfaceView } = await import("./nativeTerminalModule");
    expect(resolveNativeTerminalSurfaceView()).toBeNull();
    expect(expoModulesCoreMocks.requireNativeViewManager).not.toHaveBeenCalled();
  });

  it("returns the native terminal view when the view config is installed", async () => {
    setExpoViewConfigAvailable();
    expoModulesCoreMocks.requireNativeViewManager.mockReturnValue(nativeView);
    const { resolveNativeTerminalSurfaceView } = await import("./nativeTerminalModule");
    expect(resolveNativeTerminalSurfaceView()).toBe(nativeView);
    expect(expoModulesCoreMocks.requireNativeViewManager).toHaveBeenCalledWith("T3TerminalSurface");
  });

  it("returns null when the view manager cannot be required", async () => {
    setExpoViewConfigAvailable();
    expoModulesCoreMocks.requireNativeViewManager.mockImplementation(() => {
      throw new Error("boom");
    });
    const { resolveNativeTerminalSurfaceView } = await import("./nativeTerminalModule");
    expect(resolveNativeTerminalSurfaceView()).toBeNull();
  });
});
