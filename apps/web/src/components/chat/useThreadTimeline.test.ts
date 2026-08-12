import { CheckpointRef, MessageId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveTimelineEntries } from "../../session-logic.ts";
import type { ChatMessage, TurnDiffSummary } from "../../types.ts";
import { deriveRevertTurnCountByUserMessageId } from "./useThreadTimeline.ts";

function message(
  id: string,
  role: ChatMessage["role"],
  createdAt: string,
  turnId: string | null = null,
): ChatMessage {
  return {
    id: MessageId.make(id),
    role,
    text: id,
    turnId: turnId ? TurnId.make(turnId) : null,
    createdAt,
    updatedAt: createdAt,
    streaming: false,
  };
}

function summary(
  assistantMessageId: string,
  turnId: string,
  checkpointTurnCount: number,
): TurnDiffSummary {
  return {
    turnId: TurnId.make(turnId),
    completedAt: "2026-01-01T00:00:30Z",
    assistantMessageId: MessageId.make(assistantMessageId),
    checkpointTurnCount,
    checkpointRef: CheckpointRef.make(`checkpoint-${turnId}`),
    status: "ready",
    files: [],
  };
}

function legacySummaryWithoutCheckpointTurnCount(
  assistantMessageId: string,
  turnId: string,
): TurnDiffSummary {
  return {
    ...summary(assistantMessageId, turnId, 0),
    checkpointTurnCount: undefined,
  } as unknown as TurnDiffSummary;
}

describe("deriveRevertTurnCountByUserMessageId", () => {
  it("maps a user message to the checkpoint turn count before its assistant reply", () => {
    const timelineEntries = deriveTimelineEntries(
      [
        message("user-1", "user", "2026-01-01T00:00:00.000Z"),
        message("assistant-1", "assistant", "2026-01-01T00:00:01.000Z", "turn-1"),
      ],
      [],
      [],
    );

    const assistantTurnDiffSummary = summary("assistant-1", "turn-1", 2);

    const result = deriveRevertTurnCountByUserMessageId(
      timelineEntries,
      new Map([[MessageId.make("assistant-1"), assistantTurnDiffSummary]]),
      { [TurnId.make("turn-1")]: 2 },
    );

    expect(result.get(MessageId.make("user-1"))).toBe(1);
  });

  it("derives multiple turns in one forward pass while skipping assistants without summaries", () => {
    const timelineEntries = deriveTimelineEntries(
      [
        message("user-1", "user", "2026-01-01T00:00:00.000Z"),
        message("assistant-progress", "assistant", "2026-01-01T00:00:01.000Z", "turn-1"),
        message("assistant-1", "assistant", "2026-01-01T00:00:02.000Z", "turn-1"),
        message("user-2", "user", "2026-01-01T00:00:03.000Z"),
        message("assistant-2", "assistant", "2026-01-01T00:00:04.000Z", "turn-2"),
      ],
      [],
      [],
    );
    const summaries = new Map([
      [MessageId.make("assistant-1"), summary("assistant-1", "turn-1", 2)],
      [
        MessageId.make("assistant-2"),
        legacySummaryWithoutCheckpointTurnCount("assistant-2", "turn-2"),
      ],
    ]);

    const result = deriveRevertTurnCountByUserMessageId(timelineEntries, summaries, {
      [TurnId.make("turn-2")]: 5,
    });

    expect([...result]).toEqual([
      [MessageId.make("user-1"), 1],
      [MessageId.make("user-2"), 4],
    ]);
  });

  it("does not use a later summary after the first matching summary has no turn count", () => {
    const timelineEntries = deriveTimelineEntries(
      [
        message("user-1", "user", "2026-01-01T00:00:00.000Z"),
        message("assistant-1", "assistant", "2026-01-01T00:00:01.000Z", "turn-1"),
        message("assistant-2", "assistant", "2026-01-01T00:00:02.000Z", "turn-2"),
      ],
      [],
      [],
    );
    const summaries = new Map([
      [
        MessageId.make("assistant-1"),
        legacySummaryWithoutCheckpointTurnCount("assistant-1", "turn-1"),
      ],
      [MessageId.make("assistant-2"), summary("assistant-2", "turn-2", 3)],
    ]);

    const result = deriveRevertTurnCountByUserMessageId(timelineEntries, summaries, {});

    expect(result.has(MessageId.make("user-1"))).toBe(false);
  });
});
