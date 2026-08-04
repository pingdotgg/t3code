import { describe, expect, it } from "vite-plus/test";

import {
  AUTOMATIC_COMPLETION_DELIVERY_LABEL,
  DISMISS_AUTOMATIC_COMPLETION_ACCESSIBILITY_LABEL,
  REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL,
  buildCancelQueuedRunCommand,
  collectAutomaticCompletionMessageIds,
  resolveThreadQueueRowControls,
} from "./threadQueueControlPresentation";

const automaticIds = collectAutomaticCompletionMessageIds([
  {
    delegatedCompletion: {
      generation: 1,
      parentRunId: "run:parent",
      taskIds: ["task:child"],
    },
    id: "message:completion",
  },
  {
    id: "message:ordinary",
  },
]);

describe("threadQueueControlPresentation", () => {
  it("detects automatic completion message ownership", () => {
    expect(automaticIds.has("message:completion")).toBe(true);
    expect(automaticIds.has("message:ordinary")).toBe(false);
  });

  it("locks mutation controls for automatic completion rows while enabling dismissal", () => {
    const controls = resolveThreadQueueRowControls({
      automaticCompletionMessageIds: automaticIds,
      busy: false,
      canPromoteToSteer: true,
      canReorder: true,
      index: 1,
      queuedCount: 3,
      text: "A delegated task reached a terminal state.",
      userMessageId: "message:completion",
    });

    expect(controls.automaticCompletion).toBe(true);
    expect(controls.displayText).toBe(AUTOMATIC_COMPLETION_DELIVERY_LABEL);
    expect(controls.canMoveUp).toBe(false);
    expect(controls.canMoveDown).toBe(false);
    expect(controls.canSteer).toBe(false);
    expect(controls.canDismiss).toBe(true);
    expect(controls.dismissAccessibilityLabel).toBe(
      DISMISS_AUTOMATIC_COMPLETION_ACCESSIBILITY_LABEL,
    );
  });

  it("preserves ordinary queue reorder and steer controls with removal", () => {
    const controls = resolveThreadQueueRowControls({
      automaticCompletionMessageIds: automaticIds,
      busy: false,
      canPromoteToSteer: true,
      canReorder: true,
      index: 1,
      queuedCount: 3,
      text: "Please review the follow-up change.",
      userMessageId: "message:ordinary",
    });

    expect(controls.automaticCompletion).toBe(false);
    expect(controls.displayText).toBe("Please review the follow-up change.");
    expect(controls.canMoveUp).toBe(true);
    expect(controls.canMoveDown).toBe(true);
    expect(controls.canSteer).toBe(true);
    expect(controls.canDismiss).toBe(true);
    expect(controls.dismissAccessibilityLabel).toBe(REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL);
  });

  it("disables edge reorder controls and busy dismissal", () => {
    const firstOrdinary = resolveThreadQueueRowControls({
      automaticCompletionMessageIds: automaticIds,
      busy: false,
      canPromoteToSteer: false,
      canReorder: true,
      index: 0,
      queuedCount: 2,
      text: "First",
      userMessageId: "message:ordinary",
    });
    const busyAutomatic = resolveThreadQueueRowControls({
      automaticCompletionMessageIds: automaticIds,
      busy: true,
      canPromoteToSteer: true,
      canReorder: true,
      index: 0,
      queuedCount: 1,
      text: "A delegated task reached a terminal state.",
      userMessageId: "message:completion",
    });

    expect(firstOrdinary.canMoveUp).toBe(false);
    expect(firstOrdinary.canMoveDown).toBe(true);
    expect(firstOrdinary.canSteer).toBe(false);
    expect(busyAutomatic.canDismiss).toBe(false);
    expect(busyAutomatic.canMoveUp).toBe(false);
    expect(busyAutomatic.canSteer).toBe(false);
  });

  it("builds cancelQueuedRun command arguments for dismissal", () => {
    expect(
      buildCancelQueuedRunCommand({
        environmentId: "environment:test" as never,
        runId: "run:completion" as never,
        threadId: "thread:test" as never,
      }),
    ).toEqual({
      environmentId: "environment:test",
      input: {
        runId: "run:completion",
        threadId: "thread:test",
      },
    });
  });
});
