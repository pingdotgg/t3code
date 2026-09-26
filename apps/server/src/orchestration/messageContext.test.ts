import type { CommandReadModel } from "./CommandReadModel.ts";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

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

function makeReadModel(): CommandReadModel {
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
});
