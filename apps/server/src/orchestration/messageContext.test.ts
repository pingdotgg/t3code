import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationMessageContext,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const context: OrchestrationMessageContext = {
  version: 1,
  records: [
    {
      version: 1,
      contextId: "ctx_1" as OrchestrationMessageContext["records"][number]["contextId"],
      kind: "skill",
      label: "$pinchtab",
      name: "pinchtab",
    },
  ],
};

function makeReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        pullRequests: [],
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

function makeEvent(sequence: number, type: OrchestrationEvent["type"], payload: unknown) {
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: NOW,
    commandId: CommandId.make(`cmd-${sequence}`),
    causationEventId: null,
    payload,
  } as OrchestrationEvent;
}

it.layer(NodeServices.layer)("message context plumbing", (it) => {
  it.effect("carries context records from turn start into the message-sent event", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-1"),
            role: "user",
            text: "Use [$pinchtab](t3-context://v1/skill/ctx_1)",
            attachments: [],
            context,
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(result) ? result : [result];
      const sent = events.find((event) => event.type === "thread.message-sent");
      expect(sent?.type === "thread.message-sent" ? sent.payload.context : undefined).toEqual(
        context,
      );
    }),
  );

  it.effect("projects context records onto the read-model message", () =>
    Effect.gen(function* () {
      const afterCreate = yield* projectEvent(
        createEmptyReadModel(NOW),
        makeEvent(1, "thread.created", {
          threadId: "thread-1",
          projectId: "project-1",
          title: "demo",
          modelSelection: { provider: ProviderDriverKind.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      const afterMessage = yield* projectEvent(
        afterCreate,
        makeEvent(2, "thread.message-sent", {
          threadId: "thread-1",
          messageId: "message-1",
          role: "user",
          text: "Use [$pinchtab](t3-context://v1/skill/ctx_1)",
          attachments: [],
          context,
          turnId: null,
          streaming: false,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      const message = afterMessage.threads[0]?.messages[0];
      expect(message?.context).toEqual(context);

      // A later non-streaming update without context keeps the original records.
      const afterUpdate = yield* projectEvent(
        afterMessage,
        makeEvent(3, "thread.message-sent", {
          threadId: "thread-1",
          messageId: "message-1",
          role: "user",
          text: "edited",
          turnId: null,
          streaming: false,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      expect(afterUpdate.threads[0]?.messages[0]?.context).toEqual(context);
    }),
  );
});
