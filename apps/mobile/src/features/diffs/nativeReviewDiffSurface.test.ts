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
    expect(expoMocks.requireNativeView).not.toHaveBeenCalled();
  });

  it("returns the payload bridge when the native review diff view is installed", async () => {
    setExpoViewConfigAvailable();
    expoMocks.requireNativeView.mockReturnValue(nativeView);
    const { resolveNativeReviewDiffView } = await import("./nativeReviewDiffSurface");
    const resolvedView = resolveNativeReviewDiffView();
    expect(resolvedView).not.toBeNull();
    expect(resolvedView).not.toBe(nativeView);
    expect(resolveNativeReviewDiffView()).toBe(resolvedView);
    expect(expoMocks.requireNativeView).toHaveBeenCalledWith("T3ReviewDiffSurface");
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
    expoMocks.requireNativeView.mockReturnValue(nativeView);
    const { resolveNativeReviewDiffView } = await import("./nativeReviewDiffSurface");
    expect(resolveNativeReviewDiffView()).toBeNull();
    expect(expoMocks.requireNativeView).not.toHaveBeenCalled();
  });

  it("returns null when the view manager cannot be required", async () => {
    setExpoViewConfigAvailable();
    const cause = new Error("boom");
    expoMocks.requireNativeView.mockImplementation(() => {
      throw cause;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { resolveNativeReviewDiffView } = await import("./nativeReviewDiffSurface");

    expect(resolveNativeReviewDiffView()).toBeNull();
    expect(resolveNativeReviewDiffView()).toBeNull();
    expect(expoMocks.requireNativeView).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        _tag: "NativeViewResolutionError",
        nativeModuleName: "T3ReviewDiffSurface",
        cause,
      }),
    );
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});

describe("isPendingNativeViewRegistration", () => {
  it("recognizes registration races for the installed native view name", async () => {
    const { isPendingNativeViewRegistration } = await import("./nativeReviewDiffSurface");

    expect(
      isPendingNativeViewRegistration(
        new Error("Unable to find the 'T3ReviewDiffSurface' view for this native tag"),
      ),
    ).toBe(true);
    expect(
      isPendingNativeViewRegistration(
        new Error("Unable to find the 'T3ReviewDiffView' view for this native tag"),
      ),
    ).toBe(false);
    expect(
      isPendingNativeViewRegistration(
        new Error(
          "Unable to find the class expo.modules.t3reviewdiff.T3ReviewDiffView view with tag 1150",
        ),
      ),
    ).toBe(true);
  });
});

describe("isNativeReviewDiffDrawEvent", () => {
  it("accepts only native events emitted after diff rows draw", async () => {
    const { isNativeReviewDiffDrawEvent } = await import("./nativeReviewDiffSurface");

    expect(isNativeReviewDiffDrawEvent({ message: "draw-metrics" })).toBe(true);
    expect(isNativeReviewDiffDrawEvent({ message: "visible-range" })).toBe(true);
    expect(isNativeReviewDiffDrawEvent({ message: "rows-decoded" })).toBe(false);
  });
});
