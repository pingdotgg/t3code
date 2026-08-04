import { describe, expect, it } from "vite-plus/test";

import {
  REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL,
  buildCancelQueuedRunCommand,
  resolveThreadQueueRowControls,
} from "./threadQueueControlPresentation";

describe("threadQueueControlPresentation", () => {
  it("preserves queue reorder and steer controls with removal", () => {
    const controls = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: true,
      canReorder: true,
      index: 1,
      queuedCount: 3,
      text: "Please review the follow-up change.",
    });

    expect(controls.displayText).toBe("Please review the follow-up change.");
    expect(controls.canMoveUp).toBe(true);
    expect(controls.canMoveDown).toBe(true);
    expect(controls.canSteer).toBe(true);
    expect(controls.canDismiss).toBe(true);
    expect(controls.dismissAccessibilityLabel).toBe(REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL);
  });

  it("disables edge reorder controls and busy dismissal", () => {
    const first = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: false,
      canReorder: true,
      index: 0,
      queuedCount: 2,
      text: "First",
    });
    const busy = resolveThreadQueueRowControls({
      busy: true,
      canPromoteToSteer: true,
      canReorder: true,
      index: 0,
      queuedCount: 1,
      text: "Queued message",
    });

    expect(first.canMoveUp).toBe(false);
    expect(first.canMoveDown).toBe(true);
    expect(first.canSteer).toBe(false);
    expect(busy.canDismiss).toBe(false);
    expect(busy.canMoveUp).toBe(false);
    expect(busy.canSteer).toBe(false);
  });

  it("builds cancelQueuedRun command arguments for removal", () => {
    expect(
      buildCancelQueuedRunCommand({
        environmentId: "environment:test" as never,
        runId: "run:queued" as never,
        threadId: "thread:test" as never,
      }),
    ).toEqual({
      environmentId: "environment:test",
      input: {
        runId: "run:queued",
        threadId: "thread:test",
      },
    });
  });
});
