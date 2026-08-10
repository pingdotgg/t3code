import { describe, expect, it } from "vite-plus/test";

import {
  shouldStartWorkspaceSidebarSwipe,
  shouldToggleWorkspaceSidebarForSwipe,
  WORKSPACE_SIDEBAR_SWIPE_DISTANCE,
} from "./workspace-sidebar-swipe";

describe("shouldStartWorkspaceSidebarSwipe", () => {
  it("accepts a swipe begun inside the left-edge band", () => {
    expect(shouldStartWorkspaceSidebarSwipe(0)).toBe(true);
    expect(shouldStartWorkspaceSidebarSwipe(WORKSPACE_SIDEBAR_SWIPE_DISTANCE)).toBe(true);
  });

  it("rejects a swipe begun in the middle of the content pane", () => {
    expect(shouldStartWorkspaceSidebarSwipe(WORKSPACE_SIDEBAR_SWIPE_DISTANCE + 1)).toBe(false);
    expect(shouldStartWorkspaceSidebarSwipe(400)).toBe(false);
  });
});

describe("shouldToggleWorkspaceSidebarForSwipe", () => {
  it("hides a visible sidebar after a leftward swipe", () => {
    expect(
      shouldToggleWorkspaceSidebarForSwipe({
        primarySidebarVisible: true,
        translationX: -72,
        velocityX: 0,
      }),
    ).toBe(true);
  });

  it("shows a hidden sidebar after a rightward swipe", () => {
    expect(
      shouldToggleWorkspaceSidebarForSwipe({
        primarySidebarVisible: false,
        translationX: 72,
        velocityX: 0,
      }),
    ).toBe(true);
  });

  it("ignores short swipes in the wrong direction", () => {
    expect(
      shouldToggleWorkspaceSidebarForSwipe({
        primarySidebarVisible: true,
        translationX: 72,
        velocityX: 0,
      }),
    ).toBe(false);
  });

  it("accepts a quick fling in the requested direction", () => {
    expect(
      shouldToggleWorkspaceSidebarForSwipe({
        primarySidebarVisible: false,
        translationX: 12,
        velocityX: 700,
      }),
    ).toBe(true);
  });
});
