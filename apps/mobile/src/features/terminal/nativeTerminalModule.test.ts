import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const expoMocks = vi.hoisted(() => ({
  requireNativeView: vi.fn(),
}));
const nativeView = () => null;
const originalExpo = globalThis.expo;

function setExpoViewConfigAvailable() {
  globalThis.expo = {
    getViewConfig: vi.fn().mockReturnValue({ validAttributes: {}, directEventTypes: {} }),
  } as unknown as typeof globalThis.expo;
}

vi.mock("expo", () => ({
  requireNativeView: expoMocks.requireNativeView,
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
    expect(expoMocks.requireNativeView).not.toHaveBeenCalled();
  });

  it("returns the native terminal view when the view config is installed", async () => {
    setExpoViewConfigAvailable();
    expoMocks.requireNativeView.mockReturnValue(nativeView);
    const { resolveNativeTerminalSurfaceView } = await import("./nativeTerminalModule");
    expect(resolveNativeTerminalSurfaceView()).toBe(nativeView);
    expect(expoMocks.requireNativeView).toHaveBeenCalledWith("T3TerminalSurface");
  });

  it("returns null when the view manager cannot be required", async () => {
    setExpoViewConfigAvailable();
    const cause = new Error("boom");
    expoMocks.requireNativeView.mockImplementation(() => {
      throw cause;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { resolveNativeTerminalSurfaceView } = await import("./nativeTerminalModule");

    expect(resolveNativeTerminalSurfaceView()).toBeNull();
    expect(resolveNativeTerminalSurfaceView()).toBeNull();
    expect(expoMocks.requireNativeView).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        _tag: "NativeViewResolutionError",
        nativeModuleName: "T3TerminalSurface",
        cause,
      }),
    );
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});
