import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";

import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateActionError,
  getDesktopUpdateReleaseUrl,
  installDesktopUpdate,
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

  it("shows the download failure after returning to available", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toBe("Download failed for 1.1.0. Click to retry.");
    expect(getDesktopUpdateButtonTooltip({ ...state, notAppliedVersion: "1.1.0" })).toBe(
      "Update 1.1.0 did not apply. Click to retry.",
    );
  });

  it("shows the install failure after the desktop returns to downloaded", () => {
    // reduceDesktopUpdateStateOnInstallFailure: a refused macOS install prompt lands here.
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      message: "Desktop updater install operation reported an error.",
      errorContext: "install",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
    expect(getDesktopUpdateButtonTooltip(state)).toBe("Install failed for 1.1.0. Click to retry.");
  });

  it("reports an install the desktop refuses after accepting it", async () => {
    const downloaded: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
    };
    const failed: DesktopUpdateState = {
      ...downloaded,
      message: "OSStatus error -60006.",
      errorContext: "install",
      canRetry: true,
    };
    const listeners = new Set<(state: DesktopUpdateState) => void>();
    const emit = (state: DesktopUpdateState) => listeners.forEach((listener) => listener(state));
    const install = installDesktopUpdate({
      onUpdateState: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      installUpdate: async () => {
        // A retry's pre-install check can restore the previous failure before the restart starts.
        emit(failed);
        return { accepted: true, completed: false, state: downloaded };
      },
    });
    let settled = false;
    void install.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    emit(failed);
    const result = await install;
    expect(getDesktopUpdateActionError(result)).toBe("OSStatus error -60006.");
    expect(listeners.size).toBe(0);
  });

  it("never calls a build on the other track up to date", () => {
    // A Stable build whose switch to Nightly did not finish; the updater discards every release.
    const state: DesktopUpdateState = {
      ...baseState,
      status: "up-to-date",
      channel: "nightly",
      currentVersion: "0.1.5",
      checkedAt: "2026-11-18T00:00:00.000Z",
    };
    expect(getDesktopUpdateButtonTooltip(state)).not.toBe("Up to date");
    expect(
      getDesktopUpdateButtonTooltip({ ...state, currentVersion: "0.1.6-nightly.20261118.1" }),
    ).toBe("Up to date");
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
  it.each([undefined, "", "owner/repo/extra", "owner#notes/repo", "owner/repo?tab=notes"])(
    "keeps this build's release source when repository metadata is absent or invalid: %s",
    (repository) => {
      expect(getDesktopUpdateReleaseHistoryUrl(repository)).toBe(
        "https://github.com/ScriptedAlchemy/t3code/releases",
      );
      expect(getDesktopUpdateReleaseUrl("1.2.3", repository)).toBe(
        "https://github.com/ScriptedAlchemy/t3code/releases/tag/v1.2.3",
      );
    },
  );

  it("uses a valid repository embedded by the desktop build", () => {
    expect(getDesktopUpdateReleaseHistoryUrl("other-owner/another-fork")).toBe(
      "https://github.com/other-owner/another-fork/releases",
    );
    expect(getDesktopUpdateReleaseUrl("1.2.3-nightly.20261031.1", "other-owner/another-fork")).toBe(
      "https://github.com/other-owner/another-fork/releases/tag/v1.2.3-nightly.20261031.1",
    );
  });
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
