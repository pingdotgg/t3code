import { describe, expect, it } from "vite-plus/test";

import {
  beginSidebarSwipe,
  endSidebarSwipe,
  moveSidebarSwipe,
  shouldClaimSidebarSwipe,
  SIDEBAR_SWIPE_AXIS_LOCK_PX,
  SIDEBAR_SWIPE_COMMIT_PX,
  SIDEBAR_SWIPE_FLICK_MIN_PX,
  SIDEBAR_SWIPE_FLICK_PX_PER_MS,
  type SidebarSwipeGesture,
} from "./sidebarSwipe.logic";

function openGesture(overrides?: Partial<SidebarSwipeGesture>): SidebarSwipeGesture {
  return {
    phase: "pending",
    intent: "open",
    pointerId: 1,
    startX: 8,
    startY: 200,
    x: 8,
    y: 200,
    startTime: 0,
    time: 0,
    ...overrides,
  };
}

describe("beginSidebarSwipe", () => {
  it("ignores a mouse drag", () => {
    expect(
      beginSidebarSwipe({
        pointerType: "mouse",
        pointerId: 1,
        x: 4,
        y: 20,
        time: 0,
        intent: "open",
      }),
    ).toBeNull();
  });

  it.each([8, 200, 350])("starts an open touch drag at page x=%s", (x) => {
    expect(
      beginSidebarSwipe({
        pointerType: "touch",
        pointerId: 1,
        x,
        y: 20,
        time: 0,
        intent: "open",
      }),
    ).toMatchObject({ phase: "pending", intent: "open", startX: x });
  });

  it("starts an open drag from a pen press on the left edge", () => {
    const gesture = beginSidebarSwipe({
      pointerType: "pen",
      pointerId: 7,
      x: 12,
      y: 40,
      time: 5,
      intent: "open",
    });
    expect(gesture).toMatchObject({
      phase: "pending",
      intent: "open",
      pointerId: 7,
      startX: 12,
    });
  });

  it("starts a close drag from anywhere on the sheet", () => {
    const gesture = beginSidebarSwipe({
      pointerType: "touch",
      pointerId: 2,
      x: 280,
      y: 400,
      time: 0,
      intent: "close",
    });
    expect(gesture?.intent).toBe("close");
  });
});

describe("moveSidebarSwipe", () => {
  it("stays pending until the axis lock distance", () => {
    const moved = moveSidebarSwipe(openGesture(), {
      x: 8 + SIDEBAR_SWIPE_AXIS_LOCK_PX - 1,
      y: 200,
      time: 16,
    });
    expect(moved.phase).toBe("pending");
    expect(shouldClaimSidebarSwipe(moved)).toBe(true);
  });

  it("locks horizontal when the drag moves toward the sheet", () => {
    const moved = moveSidebarSwipe(openGesture(), {
      x: 8 + SIDEBAR_SWIPE_AXIS_LOCK_PX,
      y: 204,
      time: 20,
    });
    expect(moved.phase).toBe("horizontal");
  });

  it("cancels when vertical movement wins", () => {
    const moved = moveSidebarSwipe(openGesture(), {
      x: 12,
      y: 200 + SIDEBAR_SWIPE_AXIS_LOCK_PX + 4,
      time: 20,
    });
    expect(moved.phase).toBe("cancelled");
    expect(shouldClaimSidebarSwipe(moved)).toBe(false);
  });

  it("cancels an open drag that moves left", () => {
    const moved = moveSidebarSwipe(openGesture(), {
      x: 8 - SIDEBAR_SWIPE_AXIS_LOCK_PX,
      y: 200,
      time: 20,
    });
    expect(moved.phase).toBe("cancelled");
  });

  it("keeps a cancelled drag cancelled", () => {
    const cancelled = moveSidebarSwipe(openGesture(), { x: 0, y: 240, time: 20 });
    const later = moveSidebarSwipe(cancelled, { x: 80, y: 240, time: 40 });
    expect(later.phase).toBe("cancelled");
  });
});

describe("endSidebarSwipe", () => {
  it("ignores a tap", () => {
    expect(endSidebarSwipe(openGesture())).toBe("ignore");
  });

  it("commits once the drag crosses the distance threshold", () => {
    const gesture = moveSidebarSwipe(openGesture(), {
      x: 8 + SIDEBAR_SWIPE_COMMIT_PX,
      y: 202,
      time: 180,
    });
    expect(endSidebarSwipe(gesture)).toBe("commit");
  });

  it("commits a short fast flick", () => {
    const gesture = moveSidebarSwipe(openGesture(), {
      x: 8 + SIDEBAR_SWIPE_FLICK_MIN_PX,
      y: 201,
      time: SIDEBAR_SWIPE_FLICK_MIN_PX / SIDEBAR_SWIPE_FLICK_PX_PER_MS,
    });
    expect(gesture.phase).toBe("horizontal");
    expect(endSidebarSwipe(gesture)).toBe("commit");
  });

  it("ignores a short slow drag", () => {
    const gesture = moveSidebarSwipe(openGesture(), {
      x: 8 + SIDEBAR_SWIPE_FLICK_MIN_PX,
      y: 201,
      time: 400,
    });
    expect(endSidebarSwipe(gesture)).toBe("ignore");
  });

  it("commits a close drag that moves left", () => {
    const gesture = moveSidebarSwipe(openGesture({ intent: "close", startX: 300, x: 300 }), {
      x: 300 - SIDEBAR_SWIPE_COMMIT_PX,
      y: 200,
      time: 120,
    });
    expect(endSidebarSwipe(gesture)).toBe("commit");
  });

  it("ignores a close drag that moves right", () => {
    const gesture = moveSidebarSwipe(openGesture({ intent: "close", startX: 300, x: 300 }), {
      x: 300 + SIDEBAR_SWIPE_COMMIT_PX,
      y: 200,
      time: 120,
    });
    expect(gesture.phase).toBe("cancelled");
    expect(endSidebarSwipe(gesture)).toBe("ignore");
  });
});
