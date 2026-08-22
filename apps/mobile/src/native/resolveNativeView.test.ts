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

describe("createNativeViewResolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    globalThis.expo = undefined as unknown as typeof globalThis.expo;
  });

  afterEach(() => {
    globalThis.expo = originalExpo;
  });

  it("returns null without touching the view manager when the view is not registered", async () => {
    const { createNativeViewResolver } = await import("./resolveNativeView");
    const resolve = createNativeViewResolver("T3Example");

    expect(resolve()).toBeNull();
    expect(expoMocks.requireNativeView).not.toHaveBeenCalled();
  });

  it("re-probes while the view is unregistered so a late registration still resolves", async () => {
    const { createNativeViewResolver } = await import("./resolveNativeView");
    const resolve = createNativeViewResolver("T3Example");

    expect(resolve()).toBeNull();

    setExpoViewConfigAvailable();
    expoMocks.requireNativeView.mockReturnValue(nativeView);

    expect(resolve()).toBe(nativeView);
  });

  it("resolves and memoizes the registered view", async () => {
    setExpoViewConfigAvailable();
    expoMocks.requireNativeView.mockReturnValue(nativeView);
    const { createNativeViewResolver } = await import("./resolveNativeView");
    const resolve = createNativeViewResolver("T3Example");

    expect(resolve()).toBe(nativeView);
    expect(resolve()).toBe(nativeView);
    expect(expoMocks.requireNativeView).toHaveBeenCalledTimes(1);
    expect(expoMocks.requireNativeView).toHaveBeenCalledWith("T3Example");
  });

  it("fails closed and logs once when the view manager cannot be required", async () => {
    setExpoViewConfigAvailable();
    const cause = new Error("missing native class");
    expoMocks.requireNativeView.mockImplementation(() => {
      throw cause;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { createNativeViewResolver } = await import("./resolveNativeView");
    const resolve = createNativeViewResolver("T3Example");

    expect(resolve()).toBeNull();
    expect(resolve()).toBeNull();
    expect(expoMocks.requireNativeView).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        _tag: "NativeViewResolutionError",
        nativeModuleName: "T3Example",
        cause,
      }),
    );
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
