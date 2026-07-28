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
      id: ThreadId.make("source"),
      projectId: ProjectId.make("project"),
      title: "Original",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "approval-required",
      interactionMode: "advisor",
      executorModelSelection: {
        instanceId: ProviderInstanceId.make("claude"),
        model: "claude-sonnet",
      },
      executorMaxSubAgents: 5,
      branch: "feature/original",
      worktreePath: "/tmp/original",
      parentThreadId: null,
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      autoReviewPhase: null,
      messages: [
        {
          id: MessageId.make("source-user"),
          role: "user",
          text: "original question",
          turnId: null,
          streaming: false,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: MessageId.make("source-assistant"),
          role: "assistant",
          text: "original answer",
          turnId: null,
          streaming: false,
          createdAt: NOW,
          updatedAt: NOW,
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

it.layer(NodeServices.layer)("thread branch decider", (it) => {
  it.effect("creates an independent thread and remaps copied message ids", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.branch",
          commandId: CommandId.make("branch-command"),
          sourceThreadId: ThreadId.make("source"),
          threadId: ThreadId.make("target"),
          createdAt: NOW,
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "thread.created",
        "thread.executor-model-set",
        "thread.activity-appended",
        "thread.message-sent",
        "thread.message-sent",
      ]);
      const created = events[0];
      expect(created?.type).toBe("thread.created");
      if (created?.type === "thread.created") {
        expect(created.payload.title).toBe("Branch of Original");
        expect(created.payload.parentThreadId).toBeNull();
        expect(created.payload.branch).toBe("feature/original");
        expect(created.payload.worktreePath).toBe("/tmp/original");
      }

      const copied = events.filter((event) => event.type === "thread.message-sent");
      expect(copied.map((event) => event.payload.text)).toEqual([
        "original question",
        "original answer",
      ]);
      expect(copied.map((event) => event.payload.messageId)).not.toContain(
        MessageId.make("source-user"),
      );
      expect(new Set(copied.map((event) => event.payload.messageId)).size).toBe(2);
    }),
  );
});
