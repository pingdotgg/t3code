import { describe, expect, it, vi } from "vite-plus/test";

const expoMocks = vi.hoisted(() => ({
  requireNativeView: vi.fn(),
}));

vi.mock("expo", () => ({
  requireNativeView: expoMocks.requireNativeView,
}));

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
