import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  CheckpointRef,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  assistantMessageIdFromRuntimeEvent,
  resolveCheckpointAssistantMessageId,
  resolveRuntimeAssistantMessageId,
} from "./assistantMessageIdentity.ts";

const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: asThreadId("thread-1"),
    projectId: asProjectId("project-1"),
    title: "Thread",
    model: "gpt-5-codex",
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-03-11T00:00:00.000Z",
    updatedAt: "2026-03-11T00:00:00.000Z",
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeRuntimeEvent(overrides: Partial<ProviderRuntimeEvent> = {}): ProviderRuntimeEvent {
  return {
    type: "item.completed",
    eventId: "evt-1",
    provider: "codex",
    createdAt: "2026-03-11T00:00:01.000Z",
    threadId: asThreadId("thread-1"),
    turnId: asTurnId("turn-1"),
    itemId: "item-1",
    payload: {
      itemType: "assistant_message",
      status: "completed",
    },
    ...overrides,
  } as ProviderRuntimeEvent;
}

describe("assistantMessageIdentity", () => {
  it("uses thread-scoped assistant IDs for new runtime messages", () => {
    const event = makeRuntimeEvent();

    expect(assistantMessageIdFromRuntimeEvent(event, asThreadId("thread-1"))).toBe(
      asMessageId("assistant:thread-1:item:item-1"),
    );
  });

  it("reuses legacy persisted assistant message IDs during runtime resume", () => {
    const legacyMessageId = asMessageId("assistant:item-1");
    const thread = makeThread({
      messages: [
        {
          id: legacyMessageId,
          role: "assistant",
          text: "hello",
          turnId: asTurnId("turn-1"),
          streaming: false,
          createdAt: "2026-03-11T00:00:00.000Z",
          updatedAt: "2026-03-11T00:00:00.000Z",
        },
      ],
    });

    expect(resolveRuntimeAssistantMessageId(thread, makeRuntimeEvent())).toBe(legacyMessageId);
  });

  it("reuses legacy checkpoint-linked assistant IDs before falling back", () => {
    const legacyMessageId = asMessageId("assistant:turn-1");
    const thread = makeThread({
      checkpoints: [
        {
          turnId: asTurnId("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.makeUnsafe("refs/t3/checkpoints/thread-1/turn/1"),
          status: "ready",
          files: [],
          assistantMessageId: legacyMessageId,
          completedAt: "2026-03-11T00:00:00.000Z",
        },
      ],
    });

    expect(
      resolveCheckpointAssistantMessageId({
        thread,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
      }),
    ).toBe(legacyMessageId);

    expect(
      resolveCheckpointAssistantMessageId({
        thread: makeThread(),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-2"),
      }),
    ).toBe(asMessageId("assistant:thread-1:turn:turn-2"));
  });
});
