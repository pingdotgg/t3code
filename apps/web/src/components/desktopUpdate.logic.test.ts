import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";

import {
  canCheckForUpdate,
  type DesktopHostedEnvironmentWork,
  desktopUpdateInstallNeedsConfirmation,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
  isDesktopHostedEnvironmentIdle,
  resolveDesktopUpdateButtonAction,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("desktop update button state", () => {
  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("prefers a newly available release over a stale downloaded version", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.2.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("hides the install action while checking for a newer release", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "checking",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });
});

describe("desktop update UI helpers", () => {
  it.each(["owner/repo/extra", "owner#notes/repo", "owner/repo?tab=notes"])(
    "falls back to upstream for an invalid configured repository: %s",
    (repository) => {
      expect(getDesktopUpdateReleaseHistoryUrl(repository)).toBe(
        "https://github.com/pingdotgg/t3code/releases",
      );
      expect(getDesktopUpdateReleaseUrl("1.2.3", repository)).toBe(
        "https://github.com/pingdotgg/t3code/releases/tag/v1.2.3",
      );
    },
  );
});

describe("canCheckForUpdate", () => {
  it("returns true once an update has been downloaded so newer releases can be found", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(true);
  });
});

describe("desktop update install confirmation", () => {
  const idleThread = {
    status: "completed",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
  } as const;
  const idle: DesktopHostedEnvironmentWork = {
    shellLive: true,
    threads: [idleThread],
    terminals: [{ hasRunningSubprocess: false }],
  };

  it.each<[string, DesktopHostedEnvironmentWork, boolean]>([
    ["no running thread or terminal command", idle, true],
    [
      "a thread waiting on the user",
      { ...idle, threads: [{ ...idleThread, status: "waiting" }] },
      false,
    ],
    [
      "a terminal running a command",
      { ...idle, terminals: [{ hasRunningSubprocess: true }] },
      false,
    ],
    ["a cached or resyncing thread list", { ...idle, shellLive: false }, false],
    ["terminals not loaded yet", { ...idle, terminals: null }, false],
  ])("treats an environment with %s as idle: %s", (_case, environment, expected) => {
    expect(isDesktopHostedEnvironmentIdle(environment)).toBe(expected);
  });

  it.each<[string, ReadonlyArray<string> | null, ReadonlyArray<string> | null, boolean]>([
    ["every running backend is idle", ["primary", "wsl"], ["primary", "wsl"], false],
    ["a hosted environment is busy or unknown", null, ["primary"], true],
    ["a running backend has no idle environment", ["primary"], ["primary", "wsl"], true],
    ["the running backends cannot be read", ["primary"], null, true],
    ["no running backend is reported", ["primary"], [], true],
  ])("asks when %s: %s", (_case, idleBackendIds, runningBackendIds, expected) => {
    expect(desktopUpdateInstallNeedsConfirmation(idleBackendIds, runningBackendIds)).toBe(expected);
  });
});
