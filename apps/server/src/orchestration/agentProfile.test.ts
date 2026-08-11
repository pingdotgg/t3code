import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const profile = { id: "reviewer", scope: "environment" as const, revision: "a".repeat(64) };

const event = (sequence: number, type: OrchestrationEvent["type"], payload: unknown) =>
  ({
    sequence,
    eventId: EventId.make(`agent-profile-event-${sequence}`),
    type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-agent-profile"),
    occurredAt: now,
    commandId: CommandId.make(`agent-profile-command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload,
  }) as OrchestrationEvent;

it.effect("projects durable agent profile selection and clears it on a turn", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(
      createEmptyReadModel(now),
      event(1, "thread.created", {
        threadId: ThreadId.make("thread-agent-profile"),
        projectId: ProjectId.make("project-agent-profile"),
        title: "Agent profile",
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
    expect(created.threads[0]?.agentProfile).toBeNull();

    const selected = yield* projectEvent(
      created,
      event(2, "thread.meta-updated", {
        threadId: ThreadId.make("thread-agent-profile"),
        agentProfile: profile,
        updatedAt: now,
      }),
    );
    expect(selected.threads[0]?.agentProfile).toEqual(profile);

    const cleared = yield* projectEvent(
      selected,
      event(3, "thread.turn-start-requested", {
        threadId: ThreadId.make("thread-agent-profile"),
        messageId: "message-agent-profile",
        runtimeMode: "full-access",
        interactionMode: "default",
        agentProfile: null,
        createdAt: now,
      }),
    );
    expect(cleared.threads[0]?.agentProfile).toBeNull();
  }),
);
