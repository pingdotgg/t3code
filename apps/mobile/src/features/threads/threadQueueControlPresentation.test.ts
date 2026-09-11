import { describe, expect, it } from "vite-plus/test";

import {
  REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL,
  buildCancelQueuedRunCommand,
  resolveThreadQueueRowControls,
  resolveQueueDropBeforeRunId,
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

describe("queue drag insertion", () => {
  const rows = [
    { id: "first" as never, y: 0, height: 80 },
    { id: "second" as never, y: 80, height: 140 },
    { id: "third" as never, y: 220, height: 80 },
  ];

  it("moves between variable-height rows and to either end", () => {
    expect(resolveQueueDropBeforeRunId(rows, rows[0]!.id, 140)).toBe("third");
    expect(resolveQueueDropBeforeRunId(rows, rows[0]!.id, 300)).toBeNull();
    expect(resolveQueueDropBeforeRunId(rows, rows[2]!.id, -300)).toBe("first");
  });

  it("does not send a reorder for an unchanged or unmeasured drop", () => {
    expect(resolveQueueDropBeforeRunId(rows, rows[1]!.id, 0)).toBeUndefined();
    expect(resolveQueueDropBeforeRunId(rows, rows[2]!.id, 20)).toBeUndefined();
    expect(resolveQueueDropBeforeRunId([{ id: rows[0]!.id }], rows[0]!.id, 10)).toBeUndefined();
    expect(resolveQueueDropBeforeRunId(rows, "missing" as never, 100)).toBeUndefined();
  });
});
