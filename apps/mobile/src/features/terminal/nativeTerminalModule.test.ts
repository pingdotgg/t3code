import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    expoMocks.requireNativeView.mockImplementation(() => {
      throw new Error("boom");
    });
    const { resolveNativeTerminalSurfaceView } = await import("./nativeTerminalModule");
    expect(resolveNativeTerminalSurfaceView()).toBeNull();
  });
});
