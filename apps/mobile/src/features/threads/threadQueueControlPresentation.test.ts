import { describe, expect, it } from "vite-plus/test";

import {
  REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL,
  buildCancelQueuedRunCommand,
  resolveQueueDragBeforeRunId,
  resolveThreadQueueRowControls,
  resolveQueueDropBeforeRunId,
} from "./threadQueueControlPresentation";
import { threadDragGapOffset } from "./threadDragGap";

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

  it("keeps the row already open in the composer from being reopened or steered", () => {
    const editing = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: true,
      canReorder: true,
      index: 1,
      isEditing: true,
      queuedCount: 3,
      text: "Being edited",
    });

    expect(editing.isEditing).toBe(true);
    expect(editing.canEdit).toBe(false);
    expect(editing.canSteer).toBe(false);
    // Reordering and removing a message stay available while it is edited.
    expect(editing.canMoveUp).toBe(true);
    expect(editing.canDismiss).toBe(true);
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

  it("opens the destination gap while the dragged row crosses other rows", () => {
    const offsets = (runId: (typeof rows)[number]["id"], translation: number) => {
      const before = resolveQueueDragBeforeRunId(rows, runId, translation);
      if (before === undefined) return;
      const source = rows.find((row) => row.id === runId)!;
      const last = rows.at(-1)!;
      const insertion =
        before === null ? last.y + last.height : rows.find((row) => row.id === before)!.y;
      return rows.map((row) => threadDragGapOffset(row.y, source.y, source.height, insertion));
    };

    expect(resolveQueueDragBeforeRunId(rows, rows[0]!.id, 0)).toBe(rows[1]!.id);
    expect(offsets(rows[0]!.id, 140)).toEqual([0, -80, 0]);
    expect(offsets(rows[0]!.id, 300)).toEqual([0, -80, -80]);
    expect(offsets(rows[2]!.id, -300)).toEqual([80, 80, 0]);
    expect(offsets(rows[1]!.id, 0)).toEqual([0, 0, 0]);
  });

  it("does not send a reorder for an unchanged or unmeasured drop", () => {
    expect(resolveQueueDropBeforeRunId(rows, rows[1]!.id, 0)).toBeUndefined();
    expect(resolveQueueDropBeforeRunId(rows, rows[2]!.id, 20)).toBeUndefined();
    expect(resolveQueueDropBeforeRunId([{ id: rows[0]!.id }], rows[0]!.id, 10)).toBeUndefined();
    expect(resolveQueueDropBeforeRunId(rows, "missing" as never, 100)).toBeUndefined();
  });
});
