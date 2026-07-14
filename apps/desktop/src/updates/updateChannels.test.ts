import { assert, describe, it } from "@effect/vitest";

import { resolveDesktopAppBundleId, resolveDesktopBuildAppId } from "./updateChannels.ts";

describe("updateChannels bundle ids", () => {
  it("uses dev, nightly, and alpha bundle ids per channel", () => {
    assert.equal(
      resolveDesktopAppBundleId({ isDevelopment: true, appVersion: "0.0.28" }),
      "com.t3tools.t3code.dev",
    );
    assert.equal(
      resolveDesktopAppBundleId({
        isDevelopment: false,
        appVersion: "0.0.28-nightly.20260702.1",
      }),
      "com.t3tools.t3code.nightly",
    );
    assert.equal(
      resolveDesktopAppBundleId({ isDevelopment: false, appVersion: "0.0.28" }),
      "com.t3tools.t3code.alpha",
    );
    assert.equal(
      resolveDesktopBuildAppId("0.0.28-nightly.20260702.1"),
      "com.t3tools.t3code.nightly",
    );
    assert.equal(resolveDesktopBuildAppId("0.0.28"), "com.t3tools.t3code.alpha");
  });
});
