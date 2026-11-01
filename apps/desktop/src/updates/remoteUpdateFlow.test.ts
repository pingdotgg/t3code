import { assert, describe, it } from "@effect/vitest";
import type { DesktopUpdateState } from "@t3tools/contracts";

import {
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
    omittedReleaseCount: 0,
    ...overrides,
  };
}

describe("nextRemoteDesktopUpdateStep", () => {
  it("does not install again a version that did not apply on this machine", () => {
    const step = nextRemoteDesktopUpdateStep(
      makeState({ status: "available", availableVersion: "1.2.4", notAppliedVersion: "1.2.4" }),
      NO_ATTEMPTS,
      null,
    );
    assert.equal(step.action, "done");
    assert.include(step.action === "done" ? step.reason : "", "1.2.4 did not apply");
    assert.deepEqual(
      nextRemoteDesktopUpdateStep(
        makeState({ status: "available", availableVersion: "1.2.5", notAppliedVersion: "1.2.4" }),
        NO_ATTEMPTS,
        null,
      ),
      { action: "download" },
    );
  });

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
    assert.deepEqual(
      nextRemoteDesktopUpdateStep(
        makeState({
          status: "error",
          downloadedVersion: "1.2.4",
          errorContext: null,
          message: "background updater error",
        }),
        NO_ATTEMPTS,
        null,
      ),
      { action: "install" },
    );
    const staleError = makeState({
      status: "error",
      downloadedVersion: "1.2.4",
      errorContext: "check",
      message: "feed unreachable",
    });
    assert.deepEqual(nextRemoteDesktopUpdateStep(staleError, NO_ATTEMPTS, null), {
      action: "check",
    });
    assert.deepEqual(nextRemoteDesktopUpdateStep(staleError, { checks: 1, downloads: 0 }, null), {
      action: "done",
      outcome: "failed",
      reason: "feed unreachable",
    });
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
});
