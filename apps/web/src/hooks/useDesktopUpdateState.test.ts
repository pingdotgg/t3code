import { describe, expect, it } from "vitest";
import type { DesktopUpdateState } from "@t3tools/contracts";

import { resolveDisplayedAppVersion } from "./useDesktopUpdateState";

const baseDesktopUpdateState: DesktopUpdateState = {
  enabled: true,
  status: "up-to-date",
  currentVersion: "0.0.11",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("resolveDisplayedAppVersion", () => {
  it("keeps the fallback version outside desktop runtime", () => {
    expect(
      resolveDisplayedAppVersion({
        desktopUpdateState: baseDesktopUpdateState,
        fallbackVersion: "0.0.10",
        isDesktopRuntime: false,
      }),
    ).toBe("0.0.10");
  });

  it("prefers the desktop runtime version when available", () => {
    expect(
      resolveDisplayedAppVersion({
        desktopUpdateState: baseDesktopUpdateState,
        fallbackVersion: "0.0.10",
        isDesktopRuntime: true,
      }),
    ).toBe("0.0.11");
  });

  it("falls back when the runtime state is missing", () => {
    expect(
      resolveDisplayedAppVersion({
        desktopUpdateState: null,
        fallbackVersion: "0.0.10",
        isDesktopRuntime: true,
      }),
    ).toBe("0.0.10");
  });
});
