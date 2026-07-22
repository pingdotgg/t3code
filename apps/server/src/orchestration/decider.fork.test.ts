import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-07-21T12:00:00.000Z";
const sourceThreadId = ThreadId.make("thread-source");
const forkThreadId = ThreadId.make("thread-fork");
const turnOneId = TurnId.make("turn-1");
const turnTwoId = TurnId.make("turn-2");

const seedReadModel = (): OrchestrationReadModel => ({
  ...createEmptyReadModel(now),
  threads: [
    {
      id: sourceThreadId,
      projectId: ProjectId.make("project-1"),
      title: "Source thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: "main",
      worktreePath: "/tmp/project",
      forkedFrom: null,
      latestTurn: {
        turnId: turnTwoId,
        state: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        assistantMessageId: MessageId.make("assistant-2"),
      },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages: [
        {
          id: MessageId.make("user-1"),
          role: "user",
          text: "First question",
          attachments: [],
          turnId: turnOneId,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: MessageId.make("assistant-1"),
          role: "assistant",
          text: "First answer",
          attachments: [],
          turnId: turnOneId,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: MessageId.make("user-2"),
          role: "user",
          text: "Second question",
          attachments: [],
          turnId: turnTwoId,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: MessageId.make("assistant-2"),
          role: "assistant",
          text: "Second answer",
          attachments: [],
          turnId: turnTwoId,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: MessageId.make("assistant-streaming"),
          role: "assistant",
          text: "Unsettled answer",
          attachments: [],
          turnId: TurnId.make("turn-3"),
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
});

const forkCommand = (sourceTurnId: TurnId) => ({
  type: "thread.fork" as const,
  commandId: CommandId.make("command-fork"),
  threadId: forkThreadId,
  sourceThreadId,
  sourceTurnId,
  title: "Forked thread",
  createdAt: now,
});

type PlannedForkEvent = Omit<
  Extract<OrchestrationEvent, { readonly type: "thread.forked" }>,
  "sequence"
>;

function requireForkEvent(result: unknown): PlannedForkEvent {
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !("type" in result) ||
    result.type !== "thread.forked"
  ) {
    throw new Error("Expected one thread.forked event.");
  }
  return result as PlannedForkEvent;
}

it.layer(NodeServices.layer)("thread fork decider", (it) => {
  it.effect("copies history through the requested turn and persists lineage", () =>
    Effect.gen(function* () {
      const event = requireForkEvent(
        yield* decideOrchestrationCommand({
          command: forkCommand(turnOneId),
          readModel: seedReadModel(),
        }),
      );

      expect(event.payload.forkedFrom).toEqual({
        threadId: sourceThreadId,
        turnId: turnOneId,
      });
      expect(event.payload.inheritedMessages.map((message) => message.text)).toEqual([
        "First question",
        "First answer",
      ]);

      const projected = yield* projectEvent(seedReadModel(), {
        ...event,
        sequence: 1,
        eventId: EventId.make("event-fork"),
      });
      expect(projected.threads.find((thread) => thread.id === forkThreadId)?.forkedFrom).toEqual({
        threadId: sourceThreadId,
        turnId: turnOneId,
      });
    }),
  );

  it.effect("rejects a fork at a running turn", () =>
    Effect.gen(function* () {
      const readModel = seedReadModel();
      const source = readModel.threads[0]!;
      const error = yield* decideOrchestrationCommand({
        command: forkCommand(turnTwoId),
        readModel: {
          ...readModel,
          threads: [
            {
              ...source,
              latestTurn: {
                ...source.latestTurn!,
                state: "running",
                completedAt: null,
              },
            },
          ],
        },
      }).pipe(Effect.flip);

      expect(error.message).toContain("still running and cannot be forked");
    }),
  );
});
