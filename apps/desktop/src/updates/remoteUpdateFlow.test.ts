import { assert, describe, it } from "@effect/vitest";
import type { DesktopUpdateState } from "@t3tools/contracts";

import {
  MAX_REMOTE_UPDATE_CHECKS,
  MAX_REMOTE_UPDATE_DOWNLOADS,
  nextRemoteDesktopUpdateStep,
  type RemoteDesktopUpdateAttempts,
} from "./remoteUpdateFlow.ts";

const NO_ATTEMPTS: RemoteDesktopUpdateAttempts = { checks: 0, downloads: 0 };

function makeState(overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
  return {
    enabled: true,
    status: "idle",
    channel: "latest",
    currentVersion: "1.2.3",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
    ...overrides,
  };
}

describe("nextRemoteDesktopUpdateStep", () => {
  it("fails immediately when updates are disabled, preferring the known reason", () => {
    const state = makeState({ enabled: false, status: "disabled" });
    assert.deepEqual(nextRemoteDesktopUpdateStep(state, NO_ATTEMPTS, "dev build"), {
      action: "done",
      outcome: "failed",
      reason: "dev build",
    });
    assert.deepEqual(nextRemoteDesktopUpdateStep(state, NO_ATTEMPTS, null), {
      action: "done",
      outcome: "failed",
      reason: "Automatic updates are disabled on this machine.",
    });
  });

  it("installs only from the downloaded status the updater will accept", () => {
    assert.deepEqual(
      nextRemoteDesktopUpdateStep(
        makeState({ status: "downloaded", downloadedVersion: "1.2.4" }),
        NO_ATTEMPTS,
        null,
      ),
      { action: "install" },
    );
    // A previous install failure keeps status "downloaded", so a remote run
    // retries the install.
    assert.deepEqual(
      nextRemoteDesktopUpdateStep(
        makeState({
          status: "downloaded",
          downloadedVersion: "1.2.4",
          errorContext: "install",
          message: "quitAndInstall failed",
        }),
        NO_ATTEMPTS,
        null,
      ),
      { action: "install" },
    );
    // A leftover downloadedVersion on an error state (background updater
    // error) must not report an install the updater refuses: fresh runs
    // re-check, and post-check it fails.
    const staleError = makeState({
      status: "error",
      downloadedVersion: "1.2.4",
      message: "background updater error",
    });
    assert.deepEqual(nextRemoteDesktopUpdateStep(staleError, NO_ATTEMPTS, null), {
      action: "check",
    });
    assert.deepEqual(nextRemoteDesktopUpdateStep(staleError, { checks: 1, downloads: 0 }, null), {
      action: "done",
      outcome: "failed",
      reason: "background updater error",
    });
  });

  it("rides along while a check or download is already in flight", () => {
    assert.deepEqual(
      nextRemoteDesktopUpdateStep(makeState({ status: "checking" }), NO_ATTEMPTS, null),
      {
        action: "wait",
      },
    );
    assert.deepEqual(
      nextRemoteDesktopUpdateStep(
        makeState({ status: "downloading", availableVersion: "1.2.4", downloadPercent: 40 }),
        NO_ATTEMPTS,
        null,
      ),
      { action: "wait" },
    );
  });

  it("downloads an available update until the attempt cap, then fails", () => {
    const available = makeState({ status: "available", availableVersion: "1.2.4" });
    assert.deepEqual(nextRemoteDesktopUpdateStep(available, NO_ATTEMPTS, null), {
      action: "download",
    });
    assert.deepEqual(
      nextRemoteDesktopUpdateStep(
        available,
        { checks: 1, downloads: MAX_REMOTE_UPDATE_DOWNLOADS },
        null,
      ),
      {
        action: "done",
        outcome: "failed",
        reason: "The desktop app failed to download the update.",
      },
    );
    assert.deepEqual(
      nextRemoteDesktopUpdateStep(
        makeState({
          status: "available",
          availableVersion: "1.2.4",
          message: "network blipped",
        }),
        { checks: 1, downloads: MAX_REMOTE_UPDATE_DOWNLOADS },
        null,
      ),
      { action: "done", outcome: "failed", reason: "network blipped" },
    );
  });

  it("re-checks stale up-to-date and error states before trusting them", () => {
    // These states are retained from earlier/background checks; a remote
    // request must look again instead of replaying them.
    assert.deepEqual(
      nextRemoteDesktopUpdateStep(makeState({ status: "up-to-date" }), NO_ATTEMPTS, null),
      { action: "check" },
    );
    assert.deepEqual(
      nextRemoteDesktopUpdateStep(
        makeState({ status: "error", message: "feed unreachable" }),
        NO_ATTEMPTS,
        null,
      ),
      { action: "check" },
    );
  });

  it("reports up-to-date and error states as terminal after this run's check", () => {
    const checked = { checks: 1, downloads: 0 };
    assert.deepEqual(
      nextRemoteDesktopUpdateStep(makeState({ status: "up-to-date" }), checked, null),
      { action: "done", outcome: "up-to-date" },
    );
    assert.deepEqual(
      nextRemoteDesktopUpdateStep(
        makeState({ status: "error", message: "feed unreachable" }),
        checked,
        null,
      ),
      { action: "done", outcome: "failed", reason: "feed unreachable" },
    );
    assert.deepEqual(nextRemoteDesktopUpdateStep(makeState({ status: "error" }), checked, null), {
      action: "done",
      outcome: "failed",
      reason: "The desktop app update failed.",
    });
  });

  it("checks from idle until the attempt cap, then fails", () => {
    assert.deepEqual(nextRemoteDesktopUpdateStep(makeState(), NO_ATTEMPTS, null), {
      action: "check",
    });
    assert.deepEqual(
      nextRemoteDesktopUpdateStep(
        makeState(),
        { checks: MAX_REMOTE_UPDATE_CHECKS, downloads: 0 },
        null,
      ),
      {
        action: "done",
        outcome: "failed",
        reason: "The desktop app did not report an update result.",
      },
    );
  });
});
