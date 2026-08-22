import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const expoMocks = vi.hoisted(() => ({
  requireNativeView: vi.fn(),
}));
const nativeView = () => null;
const originalExpo = globalThis.expo;

vi.mock("expo", () => ({
  requireNativeView: expoMocks.requireNativeView,
}));

// Resolver semantics are covered by src/native/resolveNativeView.test.ts; these pin the wiring.
describe("nativeGlbViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    globalThis.expo = undefined as unknown as typeof globalThis.expo;
  });

  afterEach(() => {
    globalThis.expo = originalExpo;
  });

  it("reports the viewer as unavailable when the binary does not register the view", async () => {
    const { hasNativeGlbViewer } = await import("./nativeGlbViewer");

    expect(hasNativeGlbViewer()).toBe(false);
    expect(expoMocks.requireNativeView).not.toHaveBeenCalled();
  });

  it("resolves the T3GlbViewer view and reports it as available", async () => {
    globalThis.expo = {
      getViewConfig: vi.fn().mockReturnValue({ validAttributes: {}, directEventTypes: {} }),
    } as unknown as typeof globalThis.expo;
    expoMocks.requireNativeView.mockReturnValue(nativeView);
    const { hasNativeGlbViewer, resolveNativeGlbViewer } = await import("./nativeGlbViewer");

    expect(resolveNativeGlbViewer()).toBe(nativeView);
    expect(hasNativeGlbViewer()).toBe(true);
    expect(expoMocks.requireNativeView).toHaveBeenCalledWith("T3GlbViewer");
  });
});
