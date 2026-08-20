import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-08-15T12:00:00.000Z";
const THREAD_ID = ThreadId.make("hermes-thread");

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: THREAD_ID,
      projectId: ProjectId.make("hermes-project"),
      title: "Imported Hermes chat",
      modelSelection: {
        instanceId: ProviderInstanceId.make("hermes"),
        model: "hermes-agent",
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

it.layer(NodeServices.layer)("Hermes message import decider", (it) => {
  it.effect("preserves the imported role, text, id, and timestamp", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.import",
          commandId: CommandId.make("import-message"),
          threadId: THREAD_ID,
          messageId: MessageId.make("hermes-message"),
          role: "assistant",
          text: "Imported response",
          createdAt: NOW,
        },
        readModel,
      });

      const events: ReadonlyArray<OrchestrationEvent> = Array.isArray(result)
        ? result
        : [result as OrchestrationEvent];
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event?.type === "thread.message-sent") {
        expect(event.metadata.importedHistory).toBe(true);
        expect(event.payload).toMatchObject({
          threadId: THREAD_ID,
          messageId: MessageId.make("hermes-message"),
          role: "assistant",
          text: "Imported response",
          streaming: false,
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
    }),
  );

  it.effect("imports a complete message and activity history atomically", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.history.import",
          commandId: CommandId.make("import-history"),
          threadId: THREAD_ID,
          messages: [
            {
              messageId: MessageId.make("history-message"),
              role: "user",
              text: "Imported prompt",
              createdAt: NOW,
            },
          ],
          activities: [
            {
              id: EventId.make("history-activity"),
              tone: "tool",
              kind: "tool.completed",
              summary: "pnpm build",
              payload: { itemType: "command_execution" },
              turnId: null,
              sequence: 0,
              createdAt: NOW,
            },
          ],
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.history-imported"]);
      expect(events[0]?.metadata.importedHistory).toBe(true);
      if (events[0]?.type === "thread.history-imported") {
        expect(events[0].payload.messages).toHaveLength(1);
        expect(events[0].payload.activities).toHaveLength(1);
      }
    }),
  );
});
