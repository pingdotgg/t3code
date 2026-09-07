import { describe, expect, it } from "vite-plus/test";

import { CheckpointRef, MessageId, TurnId } from "@t3tools/contracts";
import { type TimelineEntry } from "../../session-logic";
import { type ChatMessage, type TurnDiffSummary } from "../../types";
import { deriveRevertPickerOptions } from "./revertPicker.logic";

const time = (seconds: number) => new Date(Date.UTC(2026, 8, 7, 12, 0, seconds)).toISOString();

function message(id: string, role: "user" | "assistant", createdAt: string): ChatMessage {
  return {
    id: MessageId.make(id),
    role,
    text: id,
    turnId: role === "assistant" ? TurnId.make(`turn-${id}`) : null,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
}

function entry(value: ChatMessage): TimelineEntry {
  return {
    id: `message:${value.id}`,
    kind: "message",
    createdAt: value.createdAt,
    message: value,
  };
}

function checkpoint(
  assistant: ChatMessage,
  checkpointTurnCount: number,
  files: TurnDiffSummary["files"],
): TurnDiffSummary {
  return {
    turnId: assistant.turnId!,
    checkpointTurnCount,
    checkpointRef: CheckpointRef.make(`refs/t3/checkpoints/${checkpointTurnCount}`),
    status: "ready",
    files,
    assistantMessageId: assistant.id,
    completedAt: assistant.createdAt,
  };
}

describe("deriveRevertPickerOptions", () => {
  it("returns nothing when conversation rollback is unsupported", () => {
    expect(
      deriveRevertPickerOptions({
        supportsConversationRollback: false,
        timelineEntries: [entry(message("user", "user", time(0)))],
        turnDiffSummaries: [],
        inferredCheckpointTurnCountByTurnId: {},
      }),
    ).toEqual([]);
  });

  it("lists newest messages first with cumulative discarded diffstats", () => {
    const expired = message("expired", "user", time(0));
    const userA = message("user-a", "user", time(1));
    const assistantA = message("assistant-a", "assistant", time(2));
    const userB = message("user-b", "user", time(3));
    const assistantB = message("assistant-b", "assistant", time(4));
    const userC = message("user-c", "user", time(5));
    const assistantC = message("assistant-c", "assistant", time(6));
    const pending = message("pending", "user", time(7));
    const summaries = [
      checkpoint(assistantA, 1, [{ path: "a.ts", kind: "modified", additions: 2, deletions: 1 }]),
      checkpoint(assistantB, 2, [
        { path: "shared.ts", kind: "modified", additions: 3, deletions: 2 },
      ]),
      checkpoint(assistantC, 3, [
        { path: "shared.ts", kind: "modified", additions: 5, deletions: 4 },
        { path: "c.ts", kind: "added", additions: 7, deletions: 0 },
      ]),
    ];

    const options = deriveRevertPickerOptions({
      supportsConversationRollback: true,
      timelineEntries: [
        expired,
        userA,
        assistantA,
        userB,
        assistantB,
        userC,
        assistantC,
        pending,
      ].map(entry),
      turnDiffSummaries: summaries,
      inferredCheckpointTurnCountByTurnId: {},
    });

    expect(options.map((option) => option.messageId)).toEqual([
      pending.id,
      userC.id,
      userB.id,
      userA.id,
      expired.id,
    ]);
    expect(options[0]).toMatchObject({ turnCount: null, unavailableReason: "pending" });
    expect(options[1]).toMatchObject({
      turnLabel: 3,
      turnCount: 2,
      unavailableReason: null,
      filesChanged: 2,
      additions: 12,
      deletions: 4,
    });
    expect(options[2]).toMatchObject({
      turnLabel: 2,
      turnCount: 1,
      filesChanged: 2,
      additions: 15,
      deletions: 6,
    });
    expect(options.at(-1)).toMatchObject({ turnCount: null, unavailableReason: "expired" });
  });

  it("matches older checkpoints by turn ID when assistant message IDs are absent", () => {
    const user = message("user", "user", time(0));
    const assistant = message("assistant", "assistant", time(1));
    const summary = { ...checkpoint(assistant, 1, []), assistantMessageId: null };

    expect(
      deriveRevertPickerOptions({
        supportsConversationRollback: true,
        timelineEntries: [entry(user), entry(assistant)],
        turnDiffSummaries: [summary],
        inferredCheckpointTurnCountByTurnId: { [assistant.turnId!]: 1 },
      }),
    ).toEqual([
      expect.objectContaining({
        messageId: user.id,
        turnCount: 0,
        unavailableReason: null,
      }),
    ]);
  });
});
