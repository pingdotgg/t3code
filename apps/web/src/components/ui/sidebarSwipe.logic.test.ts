import { describe, expect, it } from "vite-plus/test";

import {
  beginSidebarSwipe,
  createSidebarSwipeTracker,
  endSidebarSwipe,
  moveSidebarSwipe,
  shouldClaimSidebarSwipe,
  SIDEBAR_SWIPE_AXIS_LOCK_PX,
  SIDEBAR_SWIPE_COMMIT_PX,
  SIDEBAR_SWIPE_FLICK_MIN_PX,
  SIDEBAR_SWIPE_FLICK_PX_PER_MS,
  type SidebarSwipeGesture,
  type SidebarSwipeIntent,
  type SidebarSwipeModality,
} from "./sidebarSwipe.logic";

function openGesture(overrides?: Partial<SidebarSwipeGesture>): SidebarSwipeGesture {
  return {
    pointerType: "touch",
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
});

describe("moveSidebarSwipe", () => {
  it("stays pending until the axis lock distance", () => {
    const moved = moveSidebarSwipe(openGesture(), {
      x: 8 + SIDEBAR_SWIPE_AXIS_LOCK_PX - 1,
      y: 200,
      time: 16,
    });
    expect(moved.phase).toBe("pending");
    expect(shouldClaimSidebarSwipe(moved)).toBe(false);
  });

  it("locks horizontal when the drag moves toward the sheet", () => {
    const moved = moveSidebarSwipe(openGesture(), {
      x: 8 + SIDEBAR_SWIPE_AXIS_LOCK_PX,
      y: 204,
      time: 20,
    });
    expect(moved.phase).toBe("horizontal");
    expect(shouldClaimSidebarSwipe(moved)).toBe(true);
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

/** [event, modality, id, x, y]; drop is a multi-touch start, which only ends a stale drag. */
type Step = readonly [
  "down" | "move" | "up" | "drop" | "cancel",
  SidebarSwipeModality,
  number,
  number?,
  number?,
];

/**
 * Replay one window event stream, as the hook forwards it, and record what
 * each move claimed and what each release did.
 */
function replay(steps: ReadonlyArray<Step>, side: "left" | "right" = "left") {
  const tracker = createSidebarSwipeTracker(side);
  const claims: boolean[] = [];
  const releases: Array<SidebarSwipeIntent | "ignore" | "none"> = [];
  for (const [kind, modality, id, x = 0, y = 200] of steps) {
    const contact = { modality, id, x, y, time: 0 };
    if (kind === "down") {
      tracker.drop(modality);
      tracker.begin(contact, "open");
    } else if (kind === "move") claims.push(tracker.move(contact));
    else if (kind === "up") {
      const release = tracker.release(contact);
      releases.push(release === null ? "none" : (release.commit ?? "ignore"));
    } else if (kind === "drop") tracker.drop(modality);
    else tracker.cancel(modality, id);
  }
  return { claims, releases };
}

describe("createSidebarSwipeTracker", () => {
  it.each<{
    name: string;
    steps: ReadonlyArray<Step>;
    side?: "right";
    claims: boolean[];
    releases: string[];
  }>([
    {
      name: "a pen cancel does not end a touch drag",
      steps: [
        ["down", "touch", 0, 8],
        ["move", "touch", 0, 28],
        ["cancel", "pen", 7],
        ["up", "touch", 0, 90],
      ],
      claims: [true],
      releases: ["open"],
    },
    {
      name: "a new touch replaces one whose release never arrived",
      steps: [
        ["down", "touch", 0, 100],
        ["down", "touch", 1, 200],
        ["move", "touch", 1, 280],
        ["up", "touch", 1, 280],
      ],
      claims: [true],
      releases: ["open"],
    },
    {
      name: "a new pen press replaces one whose release never arrived",
      steps: [
        ["down", "pen", 7, 100],
        ["down", "pen", 8, 200],
        ["move", "pen", 8, 280],
        ["up", "pen", 8, 280],
      ],
      claims: [true],
      releases: ["open"],
    },
    {
      name: "a touch drag ignores pen events with the same ID",
      steps: [
        ["down", "touch", 0, 100],
        ["down", "pen", 0, 100],
        ["move", "pen", 0, 180],
        ["up", "pen", 0, 180],
        ["cancel", "pen", 0],
        ["move", "touch", 0, 180],
        ["up", "touch", 0, 180],
      ],
      claims: [false, true],
      releases: ["none", "open"],
    },
    {
      name: "a pen drag ignores single- and multi-touch events with the same ID",
      steps: [
        ["down", "pen", 0, 100],
        ["down", "touch", 0, 100],
        ["move", "touch", 0, 180],
        ["up", "touch", 0, 180],
        ["drop", "touch", 0],
        ["cancel", "touch", 0],
        ["move", "pen", 0, 180],
        ["up", "pen", 0, 180],
      ],
      claims: [false, true],
      releases: ["none", "open"],
    },
    {
      name: "only the matching touch cancels a drag",
      steps: [
        ["down", "touch", 0, 100],
        ["cancel", "touch", 1],
        ["move", "touch", 0, 180],
        ["up", "touch", 0, 180],
      ],
      claims: [true],
      releases: ["open"],
    },
    {
      name: "a cancelled touch does not commit on a later release",
      steps: [
        ["down", "touch", 0, 100],
        ["cancel", "touch", 0],
        ["up", "touch", 0, 180],
      ],
      claims: [],
      releases: ["none"],
    },
    {
      name: "tap drift followed by a vertical scroll is never claimed",
      steps: [
        ["down", "touch", 0, 150],
        ["move", "touch", 0, 152],
        ["move", "touch", 0, 153, 240],
        ["up", "touch", 0, 153, 240],
      ],
      claims: [false, false],
      releases: ["ignore"],
    },
    {
      name: "a right drawer opens from a leftward drag",
      steps: [
        ["down", "touch", 0, 250],
        ["move", "touch", 0, 150],
        ["up", "touch", 0, 150],
      ],
      side: "right",
      claims: [true],
      releases: ["open"],
    },
  ])("$name", ({ steps, side, claims, releases }) => {
    expect(replay(steps, side)).toEqual({ claims, releases });
  });
});
