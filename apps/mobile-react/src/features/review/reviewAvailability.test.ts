import { describe, expect, it } from "vite-plus/test";

import { resolveReviewAvailability } from "./reviewAvailability";

describe("resolveReviewAvailability", () => {
  it("keeps section navigation available when another section is cached offline", () => {
    expect(
      resolveReviewAvailability({
        hasEnvironmentPresentation: true,
        isEnvironmentConnected: false,
        hasCachedSelectedDiff: false,
        hasAnyCachedDiff: true,
      }),
    ).toEqual({
      showConnectionNotice: true,
      showSectionToolbar: true,
    });
  });

  it("hides section navigation when no review section is available offline", () => {
    expect(
      resolveReviewAvailability({
        hasEnvironmentPresentation: true,
        isEnvironmentConnected: false,
        hasCachedSelectedDiff: false,
        hasAnyCachedDiff: false,
      }),
    ).toEqual({
      showConnectionNotice: true,
      showSectionToolbar: false,
    });
  });

  it("shows cached selected content and navigation while offline", () => {
    expect(
      resolveReviewAvailability({
        hasEnvironmentPresentation: true,
        isEnvironmentConnected: false,
        hasCachedSelectedDiff: true,
        hasAnyCachedDiff: true,
      }),
    ).toEqual({
      showConnectionNotice: false,
      showSectionToolbar: true,
    });
  });
});
