import { assert, describe, it } from "@effect/vitest";

import { resolveDesktopRemoteCliPackage } from "./DesktopRemoteCliPackage.ts";

describe("resolveDesktopRemoteCliPackage", () => {
  it("uses the embedded runtime version instead of the 2code updater version", () => {
    assert.equal(
      resolveDesktopRemoteCliPackage({
        appVersion: "1.0.108",
        runtimeVersion: "0.0.32",
        updateChannel: "latest",
        isDevelopment: false,
      }),
      "t3@0.0.32",
    );
  });
});
