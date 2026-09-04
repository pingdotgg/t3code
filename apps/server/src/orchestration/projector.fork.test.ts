import { CommandId, EventId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-09-03T12:00:00.000Z";

const event = (sequence: number, type: "thread.created" | "thread.meta-updated", payload: never) =>
  ({
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    type,
    aggregateKind: "thread" as const,
    aggregateId: ThreadId.make("thread-fork"),
    occurredAt: NOW,
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload,
  }) as const;

it.effect("projects fork lineage and side-chat promotion", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(
      createEmptyReadModel(NOW),
      event(1, "thread.created", {
        threadId: ThreadId.make("thread-fork"),
        projectId: ProjectId.make("project-1"),
        title: "Side chat: Source",
        modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        fork: {
          sourceThreadId: ThreadId.make("thread-source"),
          sourceTurnId: TurnId.make("turn-1"),
          sourceMessageId: null,
          forkedAt: NOW,
        },
        sideChat: true,
        createdAt: NOW,
        updatedAt: NOW,
      } as never),
    );
    expect(created.threads[0]?.fork?.sourceThreadId).toBe(ThreadId.make("thread-source"));
    expect(created.threads[0]?.sideChat).toBe(true);
    expect(created.threads[0]?.messages).toEqual([]);

    const promoted = yield* projectEvent(
      created,
      event(2, "thread.meta-updated", {
        threadId: ThreadId.make("thread-fork"),
        sideChat: false,
        updatedAt: NOW,
      } as never),
    );
    expect(promoted.threads[0]?.sideChat).toBe(false);
    expect(promoted.threads[0]?.fork).toEqual(created.threads[0]?.fork);
  }),
);
