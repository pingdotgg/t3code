import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  handleSidebarUpdateReleaseNotesPopoverOpenChange,
  openSidebarUpdateReleaseNotesPopoverOnForwardTab,
  shouldUseSidebarUpdateReleaseNotesPopover,
} from "./SidebarUpdatePill";

const nightlyState: DesktopUpdateState = {
  enabled: true,
  status: "available",
  channel: "nightly",
  currentVersion: "0.0.35",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "0.0.36-nightly.3",
  downloadedVersion: null,
  releaseNotes: [{ version: "0.0.36-nightly.3", items: ["Newest change"], totalItems: 1 }],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("sidebar update release notes popover", () => {
  it("uses the popover only for visible nightly release notes", () => {
    expect(shouldUseSidebarUpdateReleaseNotesPopover(true, nightlyState)).toBe(true);
    expect(shouldUseSidebarUpdateReleaseNotesPopover(false, nightlyState)).toBe(false);
    expect(
      shouldUseSidebarUpdateReleaseNotesPopover(true, {
        ...nightlyState,
        channel: "latest",
      }),
    ).toBe(false);
    expect(
      shouldUseSidebarUpdateReleaseNotesPopover(true, {
        ...nightlyState,
        releaseNotes: [],
      }),
    ).toBe(false);
  });

  it("cancels trigger presses without canceling other open reasons", () => {
    const cancelTriggerPress = vi.fn();
    const cancelHover = vi.fn();

    handleSidebarUpdateReleaseNotesPopoverOpenChange(true, {
      reason: "trigger-press",
      cancel: cancelTriggerPress,
    });
    handleSidebarUpdateReleaseNotesPopoverOpenChange(true, {
      reason: "trigger-hover",
      cancel: cancelHover,
    });

    expect(cancelTriggerPress).toHaveBeenCalledOnce();
    expect(cancelHover).not.toHaveBeenCalled();
  });

  it("promotes forward Tab without preventing native navigation", () => {
    const open = vi.fn();
    const preventDefault = vi.fn();
    const event = { key: "Tab", shiftKey: false, preventDefault };

    openSidebarUpdateReleaseNotesPopoverOnForwardTab(event, { open }, "nightly-release-notes");

    expect(open).toHaveBeenCalledWith("nightly-release-notes");
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("does not promote backward Tab", () => {
    const open = vi.fn();

    openSidebarUpdateReleaseNotesPopoverOnForwardTab(
      { key: "Tab", shiftKey: true },
      { open },
      "nightly-release-notes",
    );

    expect(open).not.toHaveBeenCalled();
  });
});
