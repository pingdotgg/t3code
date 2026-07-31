import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const commandId = CommandId.make("cmd-lifecycle");
const projectId = ProjectId.make("project-lifecycle");
const threadId = ThreadId.make("thread-lifecycle");

async function lifecycleReadModel(): Promise<OrchestrationReadModel> {
  const now = "2026-07-30T00:00:00.000Z";
  const model = createEmptyReadModel(now);
  return Effect.runPromise(
    projectEvent(model, {
      sequence: 1,
      eventId: EventId.make("event-thread-lifecycle"),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.created",
      occurredAt: now,
      commandId,
      causationEventId: null,
      correlationId: commandId,
      metadata: {},
      payload: {
        threadId,
        projectId,
        parentThreadId: null,
        title: "Lifecycle thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        pendingRuntimeMode: null,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

describe("decider thread lifecycle", () => {
  it("settles and reopens an eligible thread", async () => {
    const readModel = await lifecycleReadModel();
    const settled = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId,
          threadId,
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    if (!("type" in settled)) {
      throw new Error("Expected settlement to emit one event.");
    }
    expect(settled.type).toBe("thread.settled");

    const reopened = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.unsettle",
          commandId,
          threadId,
          reason: "user",
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    expect(reopened).toMatchObject({
      type: "thread.unsettled",
      payload: { threadId, reason: "user" },
    });
  });

  it("stores a future snooze and permits an explicit wake", async () => {
    const readModel = await lifecycleReadModel();
    const snoozedUntil = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const snoozed = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.snooze",
          commandId,
          threadId,
          snoozedUntil,
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    expect(snoozed).toMatchObject({
      type: "thread.snoozed",
      payload: { threadId, snoozedUntil },
    });

    const woken = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.unsnooze",
          commandId,
          threadId,
          reason: "user",
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    expect(woken).toMatchObject({
      type: "thread.unsnoozed",
      payload: { threadId, reason: "user" },
    });
  });

  it("rejects a wake time that cannot be parsed", async () => {
    const readModel = await lifecycleReadModel();
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.snooze",
            commandId,
            threadId,
            // IsoDateTime is structurally a plain string, so an unparseable
            // wake time reaches the decider and must not persist as a snooze.
            snoozedUntil: "not-a-date",
          } satisfies OrchestrationCommand,
          readModel,
        }),
      ),
    ).rejects.toThrow("A snooze must end in the future.");
  });

  it("re-settling a settled thread keeps its settledAt and ordering", async () => {
    const settledAt = "2026-07-30T01:00:00.000Z";
    const updatedAt = "2026-07-30T02:00:00.000Z";
    const readModel = await Effect.runPromise(
      projectEvent(await lifecycleReadModel(), {
        sequence: 2,
        eventId: EventId.make("event-thread-settled"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.settled",
        occurredAt: settledAt,
        commandId,
        causationEventId: null,
        correlationId: commandId,
        metadata: {},
        payload: { threadId, settledAt, updatedAt },
      }),
    );

    const resettled = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId,
          threadId,
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );

    expect(resettled).toMatchObject({
      type: "thread.settled",
      payload: { threadId, settledAt, updatedAt },
    });
  });

  it("re-unsettling a thread already pinned active keeps its ordering", async () => {
    const updatedAt = "2026-07-30T03:00:00.000Z";
    const readModel = await Effect.runPromise(
      projectEvent(await lifecycleReadModel(), {
        sequence: 2,
        eventId: EventId.make("event-thread-unsettled"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.unsettled",
        occurredAt: updatedAt,
        commandId,
        causationEventId: null,
        correlationId: commandId,
        metadata: {},
        payload: { threadId, reason: "user", updatedAt },
      }),
    );

    const reopened = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.unsettle",
          commandId,
          threadId,
          reason: "user",
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );

    expect(reopened).toMatchObject({
      type: "thread.unsettled",
      payload: { threadId, reason: "user", updatedAt },
    });
  });
});
