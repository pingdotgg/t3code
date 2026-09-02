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

const NOW = "2026-01-01T00:00:00.000Z";

const readModel: OrchestrationReadModel = {
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

it.layer(NodeServices.layer)("continuation turn start decider", (it) => {
  it.effect("stamps the continuation origin on the user message it records", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-continue"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("msg-continue"),
            role: "user",
            text: "Your previous turn was stopped before it finished. Continue from that step.",
            attachments: [],
            origin: "continuation",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];
      const sent = events.find((event) => event.type === "thread.message-sent");
      expect(sent?.payload).toMatchObject({
        messageId: "msg-continue",
        role: "user",
        origin: "continuation",
      });
    }),
  );

  it.effect("leaves ordinary messages without an origin", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-plain"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("msg-plain"),
            role: "user",
            text: "Hello",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];
      const sent = events.find((event) => event.type === "thread.message-sent");
      expect(sent?.payload).not.toHaveProperty("origin");
    }),
  );
});
