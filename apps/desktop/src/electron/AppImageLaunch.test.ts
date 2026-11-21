import { assert, describe, it } from "@effect/vitest";

import { launchDetachedAppImage } from "./AppImageLaunch.ts";

describe("launchDetachedAppImage", () => {
  it.each(["relative/T3-Code.AppImage", "/nonexistent/T3-Code.AppImage", "/dev/null"])(
    "reports that %s could not be started",
    (appImagePath) => {
      assert.isFalse(launchDetachedAppImage(appImagePath, []));
    },
  );
});
