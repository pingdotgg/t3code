import { describe, expect, it } from "vitest";
import type { DesktopUpdateState } from "@t3tools/contracts";

import {
  getCanRetryAfterDownloadFailure,
  getAutoUpdateDisabledReason,
  nextStatusAfterDownloadFailure,
  shouldBroadcastDownloadProgress,
} from "./updateState";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("shouldBroadcastDownloadProgress", () => {
  it("broadcasts the first downloading progress update", () => {
    expect(
      shouldBroadcastDownloadProgress(
        { ...baseState, status: "downloading", downloadPercent: null },
        1,
      ),
    ).toBe(true);
  });

  it("skips progress updates within the same 10% bucket", () => {
    expect(
      shouldBroadcastDownloadProgress(
        { ...baseState, status: "downloading", downloadPercent: 11.2 },
        18.7,
      ),
    ).toBe(false);
  });

  it("broadcasts progress updates when a new 10% bucket is reached", () => {
    expect(
      shouldBroadcastDownloadProgress(
        { ...baseState, status: "downloading", downloadPercent: 19.9 },
        20.1,
      ),
    ).toBe(true);
  });

  it("broadcasts progress updates when a retry resets the download percentage", () => {
    expect(
      shouldBroadcastDownloadProgress(
        { ...baseState, status: "downloading", downloadPercent: 50.4 },
        0.2,
      ),
    ).toBe(true);
  });
});

describe("getAutoUpdateDisabledReason", () => {
  it("reports development builds as disabled", () => {
    expect(
      getAutoUpdateDisabledReason({
        isDevelopment: true,
        isPackaged: false,
        platform: "darwin",
        appImage: undefined,
        disabledByEnv: false,
        hasUpdateFeedConfig: true,
      }),
    ).toContain("packaged production builds");
  });

  it("reports packaged local builds without an update feed as disabled", () => {
    expect(
      getAutoUpdateDisabledReason({
        isDevelopment: false,
        isPackaged: true,
        platform: "darwin",
        appImage: undefined,
        disabledByEnv: false,
        hasUpdateFeedConfig: false,
      }),
    ).toContain("no update feed");
  });

  it("allows packaged builds with an update feed", () => {
    expect(
      getAutoUpdateDisabledReason({
        isDevelopment: false,
        isPackaged: true,
        platform: "darwin",
        appImage: undefined,
        disabledByEnv: false,
        hasUpdateFeedConfig: true,
      }),
    ).toBeNull();
  });

  it("reports env-disabled auto updates", () => {
    expect(
      getAutoUpdateDisabledReason({
        isDevelopment: false,
        isPackaged: true,
        platform: "darwin",
        appImage: undefined,
        disabledByEnv: true,
        hasUpdateFeedConfig: true,
      }),
    ).toContain("T3CODE_DISABLE_AUTO_UPDATE");
  });

  it("reports linux non-AppImage builds as disabled", () => {
    expect(
      getAutoUpdateDisabledReason({
        isDevelopment: false,
        isPackaged: true,
        platform: "linux",
        appImage: undefined,
        disabledByEnv: false,
        hasUpdateFeedConfig: true,
      }),
    ).toContain("AppImage");
  });
});

describe("nextStatusAfterDownloadFailure", () => {
  it("returns available when an update version is still known", () => {
    expect(
      nextStatusAfterDownloadFailure({
        ...baseState,
        status: "downloading",
        availableVersion: "1.1.0",
      }),
    ).toBe("available");
  });

  it("returns error when no update version can be retried", () => {
    expect(
      nextStatusAfterDownloadFailure({
        ...baseState,
        status: "downloading",
        availableVersion: null,
      }),
    ).toBe("error");
  });
});

describe("getCanRetryAfterDownloadFailure", () => {
  it("returns true when an available version is still present", () => {
    expect(
      getCanRetryAfterDownloadFailure({
        ...baseState,
        status: "downloading",
        availableVersion: "1.1.0",
      }),
    ).toBe(true);
  });

  it("returns false when no version is available to retry", () => {
    expect(
      getCanRetryAfterDownloadFailure({
        ...baseState,
        status: "downloading",
        availableVersion: null,
      }),
    ).toBe(false);
  });
});
