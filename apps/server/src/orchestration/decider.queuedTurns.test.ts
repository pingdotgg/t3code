import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-08-16T12:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-queue-test");
const MESSAGE_ID = MessageId.make("message-queue-test");

function makeReadModel(deliveryState?: "queued"): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-queue-test"),
        title: "Queue test",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        messages:
          deliveryState === undefined
            ? []
            : [
                {
                  id: MESSAGE_ID,
                  role: "user",
                  text: "Run this next",
                  turnId: null,
                  streaming: false,
                  createdAt: NOW,
                  updatedAt: NOW,
                  deliveryState,
                },
              ],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("queued turn decider", (it) => {
  it.effect("persists after-current delivery instead of starting the provider immediately", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-queue-turn"),
          threadId: THREAD_ID,
          message: {
            messageId: MESSAGE_ID,
            role: "user",
            text: "Run this next",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          deliveryMode: "after-current",
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      });

      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-queued",
      ]);
    }),
  );

  it.effect("dispatches a queued message into the normal provider start path", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.dispatch",
          commandId: CommandId.make("cmd-dispatch-queued-turn"),
          threadId: THREAD_ID,
          messageId: MESSAGE_ID,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          queuedAt: NOW,
          createdAt: "2026-08-16T12:01:00.000Z",
        },
        readModel: makeReadModel("queued"),
      });

      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.queued-turn-dispatched",
        "thread.turn-start-requested",
      ]);
      const start = events[1];
      expect(start?.type).toBe("thread.turn-start-requested");
      if (start?.type === "thread.turn-start-requested") {
        expect(start.payload.messageId).toBe(MESSAGE_ID);
        expect(start.payload.createdAt).toBe(NOW);
      }
    }),
  );

  it.effect("cancels only messages that are still queued", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.cancel",
          commandId: CommandId.make("cmd-cancel-queued-turn"),
          threadId: THREAD_ID,
          messageId: MESSAGE_ID,
          createdAt: NOW,
        },
        readModel: makeReadModel("queued"),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.queued-turn-cancelled"]);

      const failure = yield* Effect.result(
        decideOrchestrationCommand({
          command: {
            type: "thread.queued-turn.cancel",
            commandId: CommandId.make("cmd-cancel-delivered-turn"),
            threadId: THREAD_ID,
            messageId: MESSAGE_ID,
            createdAt: NOW,
          },
          readModel: makeReadModel(),
        }),
      );
      expect(failure._tag).toBe("Failure");
    }),
  );
});
