import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveMobileEditableMessageId } from "./message-correction";

const userMessageId = MessageId.make("user-1");
const assistantMessageId = MessageId.make("assistant-1");
const turnId = TurnId.make("turn-1");
const occurredAt = "2026-08-16T10:00:00.000Z";

const completedThread: OrchestrationThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: {
    turnId,
    state: "completed",
    requestedAt: "2026-08-16T09:00:00.000Z",
    startedAt: "2026-08-16T09:00:00.000Z",
    completedAt: "2026-08-16T09:01:00.000Z",
    assistantMessageId,
  },
  createdAt: "2026-08-16T09:00:00.000Z",
  updatedAt: "2026-08-16T09:01:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  deletedAt: null,
  messages: [
    {
      id: userMessageId,
      role: "user",
      text: "Original request",
      turnId: null,
      streaming: false,
      createdAt: "2026-08-16T09:00:00.000Z",
      updatedAt: "2026-08-16T09:00:00.000Z",
    },
    {
      id: assistantMessageId,
      role: "assistant",
      text: "Completed response",
      turnId,
      streaming: false,
      createdAt: "2026-08-16T09:01:00.000Z",
      updatedAt: "2026-08-16T09:01:00.000Z",
    },
  ],
  proposedPlans: [],
  activities: [],
  checkpoints: [
    {
      turnId,
      checkpointTurnCount: 1,
      checkpointRef: "refs/t3/checkpoints/thread-1/turn/1" as never,
      status: "ready",
      files: [],
      assistantMessageId,
      completedAt: "2026-08-16T09:01:00.000Z",
    },
  ],
  session: null,
};

describe("deriveMobileEditableMessageId", () => {
  it("keeps the latest user message editable after its checkpoint is ready", () => {
    expect(
      deriveMobileEditableMessageId({
        connected: true,
        correctionSupported: true,
        thread: completedThread,
        occurredAt,
      }),
    ).toBe(userMessageId);
  });

  it("requires a connected server with correction support", () => {
    expect(
      deriveMobileEditableMessageId({
        connected: false,
        correctionSupported: true,
        thread: completedThread,
        occurredAt,
      }),
    ).toBeNull();
  });
});
