import { describe, expect, it } from "vite-plus/test";

import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";

const runtimeInfo = {
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
} as const;

describe("updateMachine", () => {
  it("clears transient errors when a check starts", () => {
    const state = reduceDesktopUpdateStateOnCheckStart(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "error",
        message: "network",
        errorContext: "check",
        canRetry: true,
      },
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("checking");
    expect(state.message).toBeNull();
    expect(state.errorContext).toBeNull();
    expect(state.canRetry).toBe(false);
  });

  it("records a check failure without exposing an action", () => {
    const state = reduceDesktopUpdateStateOnCheckFailure(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "checking",
      },
      "network unavailable",
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("error");
    expect(state.errorContext).toBe("check");
    expect(state.canRetry).toBe(true);
  });

  it("preserves an already-downloaded update while checking the feed", () => {
    const downloadedState = {
      ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
      enabled: true,
      status: "downloaded" as const,
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      releaseNotes: [{ version: "1.1.0", items: ["fix: queued update"] }],
      downloadPercent: 100,
    };
    const checking = reduceDesktopUpdateStateOnCheckStart(
      downloadedState,
      "2026-03-04T00:00:00.000Z",
    );
    const failed = reduceDesktopUpdateStateOnCheckFailure(
      checking,
      "network unavailable",
      "2026-03-04T00:00:01.000Z",
    );

    expect(checking.status).toBe("checking");
    expect(checking.downloadedVersion).toBe("1.1.0");
    expect(checking.releaseNotes).toEqual(downloadedState.releaseNotes);
    expect(failed.status).toBe("downloaded");
    expect(failed.downloadedVersion).toBe("1.1.0");
    expect(failed.releaseNotes).toEqual(downloadedState.releaseNotes);
    expect(failed.message).toBeNull();
  });

  it("keeps the installer when the feed still offers its version", () => {
    const releaseNotes = [{ version: "1.1.0", items: ["fix: queued update"] }];
    const state = reduceDesktopUpdateStateOnUpdateAvailable(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
        releaseNotes,
        downloadPercent: 100,
      },
      "1.1.0",
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("downloaded");
    expect(state.downloadedVersion).toBe("1.1.0");
    expect(state.releaseNotes).toEqual(releaseNotes);
    expect(state.downloadPercent).toBe(100);
  });

  it("preserves available version on download failure for retry", () => {
    const state = reduceDesktopUpdateStateOnDownloadFailure(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "downloading",
        availableVersion: "1.1.0",
        downloadPercent: 43,
      },
      "checksum mismatch",
    );

    expect(state.status).toBe("available");
    expect(state.availableVersion).toBe("1.1.0");
    expect(state.errorContext).toBe("download");
    expect(state.canRetry).toBe(true);
  });

  it("transitions to downloaded and then preserves install retry state", () => {
    const downloaded = reduceDesktopUpdateStateOnDownloadComplete(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "downloading",
        availableVersion: "1.1.0",
      },
      "1.1.0",
    );
    const failedInstall = reduceDesktopUpdateStateOnInstallFailure(
      downloaded,
      "backend shutdown timed out",
    );

    expect(downloaded.status).toBe("downloaded");
    expect(downloaded.downloadedVersion).toBe("1.1.0");
    expect(failedInstall.status).toBe("downloaded");
    expect(failedInstall.errorContext).toBe("install");
    expect(failedInstall.canRetry).toBe(true);
  });

  it("preserves a downloaded update when no update is available", () => {
    const releaseNotes = [{ version: "1.1.0", items: ["fix: queued update"] }];
    const state = reduceDesktopUpdateStateOnNoUpdate(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "error",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
        releaseNotes,
        message: "old failure",
        errorContext: "download",
        canRetry: true,
      },
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("downloaded");
    expect(state.availableVersion).toBe("1.1.0");
    expect(state.downloadedVersion).toBe("1.1.0");
    expect(state.releaseNotes).toBe(releaseNotes);
    expect(state.downloadPercent).toBe(100);
    expect(state.message).toBeNull();
    expect(state.errorContext).toBeNull();
    expect(state.canRetry).toBe(true);
  });

  it("clears stale available state when no update is available", () => {
    const state = reduceDesktopUpdateStateOnNoUpdate(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "error",
        availableVersion: "1.1.0",
        releaseNotes: [{ version: "1.1.0", items: ["fix: stale update"] }],
        message: "old failure",
        errorContext: "download",
        canRetry: true,
      },
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("up-to-date");
    expect(state.availableVersion).toBeNull();
    expect(state.downloadedVersion).toBeNull();
    expect(state.releaseNotes).toEqual([]);
    expect(state.message).toBeNull();
    expect(state.errorContext).toBeNull();
  });

  it("tracks available, download start, and progress cleanly", () => {
    const releaseNotes = [
      {
        version: "1.1.0",
        items: ["feat: add update release notes"],
      },
    ];
    const available = reduceDesktopUpdateStateOnUpdateAvailable(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "checking",
      },
      "1.1.0",
      "2026-03-04T00:00:00.000Z",
      releaseNotes,
    );
    const downloading = reduceDesktopUpdateStateOnDownloadStart(available);
    const progress = reduceDesktopUpdateStateOnDownloadProgress(downloading, 55.5);

    expect(available.status).toBe("available");
    expect(available.channel).toBe("latest");
    expect(available.releaseNotes).toBe(releaseNotes);
    expect(downloading.releaseNotes).toBe(releaseNotes);
    expect(downloading.status).toBe("downloading");
    expect(downloading.downloadPercent).toBe(0);
    expect(progress.downloadPercent).toBe(55.5);
    expect(progress.errorContext).toBeNull();
  });

  it("clears release notes when checking again", () => {
    const state = reduceDesktopUpdateStateOnCheckStart(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "nightly"),
        enabled: true,
        status: "available",
        availableVersion: "1.1.0-nightly.1",
        releaseNotes: [{ version: "1.1.0-nightly.1", items: ["feat: old note"] }],
      },
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.releaseNotes).toEqual([]);
  });
});
