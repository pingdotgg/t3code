import { EventId, ProjectId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const before = "2026-09-05T04:18:50.462Z";
const after = "2026-09-04T17:18:56.456Z";
const threadId = ThreadId.make("clock-thread");

interface InputEvent {
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
  readonly at: string;
}

const replay = Effect.fn("replayClockCorrection")(function* (events: ReadonlyArray<InputEvent>) {
  let model = createEmptyReadModel(before);
  const allEvents: ReadonlyArray<InputEvent> = [
    {
      type: "thread.created",
      at: before,
      payload: {
        threadId,
        projectId: ProjectId.make("clock-project"),
        title: "Clock correction",
        modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: before,
        updatedAt: before,
      },
    },
    ...events,
  ];
  for (const [index, entry] of allEvents.entries()) {
    model = yield* projectEvent(model, {
      sequence: index + 1,
      eventId: EventId.make(`clock-event-${index + 1}`),
      aggregateKind: "thread",
      aggregateId: threadId,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      occurredAt: entry.at,
      type: entry.type,
      payload: entry.payload as never,
    } as OrchestrationEvent);
  }
  return model.threads[0]!;
});

function message(
  id: string,
  at: string,
  role = "assistant",
  turnId: string | null = null,
): InputEvent {
  return {
    type: "thread.message-sent",
    at,
    payload: {
      threadId,
      messageId: id,
      role,
      text: id,
      turnId,
      streaming: true,
      createdAt: at,
      updatedAt: at,
    },
  };
}

function plan(id: string, at: string): InputEvent {
  return {
    type: "thread.proposed-plan-upserted",
    at,
    payload: {
      threadId,
      proposedPlan: { id, turnId: null, planMarkdown: id, createdAt: at, updatedAt: at },
    },
  };
}

function activity(id: string, at: string, sequence: number): InputEvent {
  return {
    type: "thread.activity-appended",
    at,
    payload: {
      threadId,
      activity: {
        id,
        tone: "tool",
        kind: "tool.completed",
        summary: id,
        payload: {},
        turnId: null,
        sequence,
        createdAt: at,
      },
    },
  };
}

function session(
  turnId: string | null,
  status: "running" | "ready" | "interrupted",
  at: string,
): InputEvent {
  return {
    type: "thread.session-set",
    at,
    payload: {
      threadId,
      session: {
        threadId,
        status,
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: turnId,
        lastError: null,
        updatedAt: at,
      },
    },
  };
}

function checkpoint(turnId: string, count: number, at: string): InputEvent {
  return {
    type: "thread.turn-diff-completed",
    at,
    payload: {
      threadId,
      turnId,
      checkpointTurnCount: count,
      checkpointRef: `refs/t3/checkpoints/${count}`,
      status: "ready",
      files: [],
      assistantMessageId: `assistant-${count}`,
      completedAt: at,
    },
  };
}

describe("projector chronology across clock corrections", () => {
  it.effect(
    "associates an early assistant turn once and keeps its anchor on repeated sessions",
    () =>
      Effect.gen(function* () {
        const thread = yield* replay([
          message("prompt", before, "user"),
          message("assistant-1", after, "assistant", "turn-1"),
          checkpoint("turn-1", 1, after),
          session("turn-1", "running", after),
          message("queued-prompt", after, "user"),
          session("turn-1", "running", after),
        ]);
        expect(thread.latestTurn).toMatchObject({ turnId: "turn-1", createdSequence: 2 });
      }),
  );

  it.effect("does not anchor a late checkpoint to a newer queued prompt", () =>
    Effect.gen(function* () {
      const knownTurn = yield* replay([
        message("assistant-1", before, "assistant", "old-turn"),
        message("new-prompt", after, "user"),
        checkpoint("old-turn", 1, before),
      ]);
      expect(knownTurn.latestTurn).toMatchObject({ turnId: "old-turn", createdSequence: 2 });
      const unseenTurn = yield* replay([
        message("new-prompt", after, "user"),
        checkpoint("unseen-old-turn", 1, before),
      ]);
      expect(unseenTurn.latestTurn).toMatchObject({
        turnId: "unseen-old-turn",
        createdSequence: 3,
      });
    }),
  );

  it.effect("preserves first event positions through streaming and repeated upserts", () =>
    Effect.gen(function* () {
      const thread = yield* replay([
        message("before-message", before),
        plan("before-plan", before),
        activity("before-activity", before, 100),
        message("after-message", after),
        plan("after-plan", after),
        activity("after-activity", after, 1),
        message("before-message", after),
        plan("before-plan", after),
        activity("before-activity", after, 101),
      ]);

      expect(thread.messages.map(({ id, createdSequence }) => [id, createdSequence])).toEqual([
        ["before-message", 2],
        ["after-message", 5],
      ]);
      expect(thread.messages[0]?.text).toBe("before-messagebefore-message");
      expect(thread.messages[0]?.createdAt).toBe(before);
      expect(thread.proposedPlans.map(({ id, createdSequence }) => [id, createdSequence])).toEqual([
        ["before-plan", 3],
        ["after-plan", 6],
      ]);
      expect(thread.activities.map(({ id, createdSequence }) => [id, createdSequence])).toEqual([
        ["before-activity", 4],
        ["after-activity", 7],
      ]);
    }),
  );

  it.effect("selects the new completed task after a prior turn crosses the clock correction", () =>
    Effect.gen(function* () {
      const thread = yield* replay([
        message("old-prompt", before, "user"),
        session("old-turn", "running", before),
        session(null, "interrupted", after),
        message("new-prompt", after, "user"),
        session("new-turn", "running", after),
        session(null, "ready", after),
      ]);

      expect(thread.latestTurn).toMatchObject({
        turnId: "new-turn",
        createdSequence: 5,
        state: "completed",
      });
      expect(thread.session?.status).toBe("ready");
      expect(thread.messages.map(({ id }) => id)).toEqual(["old-prompt", "new-prompt"]);
    }),
  );

  it.effect("reverting keeps the initiating prompt of the retained turn", () =>
    Effect.gen(function* () {
      const thread = yield* replay([
        message("old-prompt", before, "user"),
        message("assistant-1", before, "assistant", "turn-1"),
        checkpoint("turn-1", 1, before),
        message("new-prompt", after, "user"),
        message("assistant-2", after, "assistant", "turn-2"),
        checkpoint("turn-2", 2, after),
        { type: "thread.reverted", at: after, payload: { threadId, turnCount: 1 } },
      ]);

      expect(thread.messages.map(({ id }) => id)).toEqual(["old-prompt", "assistant-1"]);
      expect(thread.latestTurn).toMatchObject({
        turnId: "turn-1",
        createdSequence: 2,
        state: "completed",
      });
    }),
  );
});
