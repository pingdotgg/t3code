import type { DesktopUpdateState } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({ addToast: vi.fn() }));

vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.addToast },
}));

import { DesktopUpdateReleaseNotes } from "./desktopUpdate.releaseNotes";
import { showDesktopUpdateDownloadedToast } from "./desktopUpdate.toast";

function downloadedState(overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
  return {
    enabled: true,
    status: "downloaded",
    channel: "latest",
    currentVersion: "0.0.29",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: "0.0.30",
    downloadedVersion: "0.0.30",
    releaseNotes: [],
    downloadPercent: 100,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: true,
    ...overrides,
  };
}

describe("showDesktopUpdateDownloadedToast", () => {
  beforeEach(() => testState.addToast.mockReset());

  it("shows the downloaded release notes in an in-app disclosure", () => {
    const releaseNotes = [
      { version: "0.0.30", items: ["Fix updater toast", "Fix updater toast"] },
      { version: "0.0.29", items: ["Improve downloads"] },
    ];

    showDesktopUpdateDownloadedToast(downloadedState({ releaseNotes }));

    expect(testState.addToast).toHaveBeenCalledWith({
      data: {
        expandableContent: <DesktopUpdateReleaseNotes releaseNotes={releaseNotes} />,
        expandableLabels: { collapse: "Hide changes", expand: "View changes" },
      },
      type: "success",
      title: "Update downloaded",
      description: "Restart the app from the update button to install it.",
    });
  });

  it("omits the disclosure when release notes are unavailable", () => {
    showDesktopUpdateDownloadedToast(downloadedState());

    expect(testState.addToast).toHaveBeenCalledWith({
      data: undefined,
      type: "success",
      title: "Update downloaded",
      description: "Restart the app from the update button to install it.",
    });
  });
});
