import { formatAssistantCitationHref } from "@t3tools/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadQueueRowControls,
  resolveQueueDropBeforeRunId,
} from "./threadQueueControlPresentation";

describe("threadQueueControlPresentation", () => {
  it.each([
    { busy: false, isEditing: false, expected: true },
    { busy: true, isEditing: false, expected: false },
    { busy: false, isEditing: true, expected: false },
  ])(
    "gates sending a stopped thread's queued message with $busy busy and $isEditing editing",
    ({ busy, isEditing, expected }) => {
      const controls = resolveThreadQueueRowControls({
        busy,
        isEditing,
        canPromoteToSteer: false,
        canSendNow: true,
        canReorder: false,
        index: 0,
        queuedCount: 1,
        text: "Queued message",
      });

      expect(controls.canSend).toBe(expected);
    },
  );

  it("shows an assistant quote as its quoted text", () => {
    const href = formatAssistantCitationHref({
      version: 1,
      environmentId: "environment:test" as never,
      threadId: "thread:test" as never,
      messageId: "message:assistant" as never,
      text: "Retry the sync after the lock clears.",
      start: 0,
      end: 37,
      prefix: "",
      suffix: "",
    });
    const controls = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: true,
      canSendNow: false,
      canReorder: true,
      index: 0,
      queuedCount: 1,
      text: `[Assistant quote](${href}) Can we add a backoff here?`,
    });

    expect(controls.displayText).toBe(
      "Retry the sync after the lock clears. Can we add a backoff here?",
    );
  });

  it("keeps the row already open in the composer from being reopened or steered", () => {
    const editing = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: true,
      canSendNow: false,
      canReorder: true,
      index: 1,
      isEditing: true,
      queuedCount: 3,
      text: "Being edited",
    });

    expect(editing.isEditing).toBe(true);
    expect(editing.canEdit).toBe(false);
    expect(editing.canSend).toBe(false);
    expect(editing.canMoveUp).toBe(true);
    expect(editing.canDismiss).toBe(true);
  });

  it("lets the owner cancel a guest's queued message but not rewrite it", () => {
    const guest = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: true,
      canSendNow: false,
      canReorder: true,
      index: 0,
      isGuestMessage: true,
      queuedCount: 1,
      text: "Why?",
    });

    expect(guest.canEdit).toBe(false);
    expect(guest.canDismiss).toBe(true);
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
