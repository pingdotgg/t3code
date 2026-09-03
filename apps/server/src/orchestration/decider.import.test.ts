import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-08-21T03:22:43.000Z";

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Imported Codex thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
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
      pinOrderKey: null,
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

it.layer(NodeServices.layer)("provider history import decider", (it) => {
  it.effect("projects an imported assistant message without requesting a provider turn", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.import",
          commandId: CommandId.make("provider-import:message-1"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          role: "assistant",
          text: "Imported response",
          turnId: TurnId.make("turn-1"),
          createdAt: NOW,
        },
        readModel,
      });

      const events = Array.isArray(result) ? result : [result];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.message-sent");
      if (events[0]?.type === "thread.message-sent") {
        expect(events[0].payload).toMatchObject({
          role: "assistant",
          text: "Imported response",
          turnId: "turn-1",
          streaming: false,
        });
      }
    }),
  );

  it.effect("projects imported user history with its provider turn identity", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.import",
          commandId: CommandId.make("provider-import:user-message-1"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("user-message-1"),
          role: "user",
          text: "Imported prompt",
          turnId: TurnId.make("turn-1"),
          createdAt: NOW,
        },
        readModel,
      });

      const events = Array.isArray(result) ? result : [result];
      expect(events[0]).toMatchObject({
        type: "thread.message-sent",
        payload: {
          role: "user",
          text: "Imported prompt",
          turnId: "turn-1",
          streaming: false,
        },
      });
    }),
  );
});
