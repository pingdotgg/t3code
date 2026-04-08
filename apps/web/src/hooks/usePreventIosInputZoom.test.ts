import { describe, expect, it } from "vitest";

import {
  buildInputZoomLockedViewportContent,
  isIosInputZoomPlatform,
} from "./usePreventIosInputZoom";

describe("isIosInputZoomPlatform", () => {
  it("detects iPhone user agents", () => {
    expect(
      isIosInputZoomPlatform({
        maxTouchPoints: 5,
        platform: "iPhone",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15",
      }),
    ).toBe(true);
  });

  it("detects iPadOS devices that report as MacIntel", () => {
    expect(
      isIosInputZoomPlatform({
        maxTouchPoints: 5,
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      }),
    ).toBe(true);
  });

  it("ignores desktop macOS", () => {
    expect(
      isIosInputZoomPlatform({
        maxTouchPoints: 0,
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      }),
    ).toBe(false);
  });
});

describe("buildInputZoomLockedViewportContent", () => {
  it("adds the focus zoom lock directives", () => {
    expect(buildInputZoomLockedViewportContent("width=device-width, initial-scale=1.0")).toBe(
      "width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no",
    );
  });

  it("replaces existing maximum scale directives", () => {
    expect(
      buildInputZoomLockedViewportContent(
        "width=device-width, initial-scale=1.0, maximum-scale=5, user-scalable=yes",
      ),
    ).toBe("width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no");
  });
});
