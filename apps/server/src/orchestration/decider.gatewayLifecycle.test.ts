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

function readModel(status: "running" | "interrupted" | "error"): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: {
          turnId: "turn-1",
          state: status,
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: status === "running" ? null : NOW,
          assistantMessageId: null,
        },
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
        messages: [
          {
            id: MessageId.make("message-1"),
            role: "user",
            text: "try it",
            attachments: [],
            turnId: "turn-1",
            streaming: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: {
          threadId: ThreadId.make("thread-1"),
          status,
          providerName: "Codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: status === "running" ? "turn-1" : null,
          updatedAt: NOW,
        },
      },
    ],
    updatedAt: NOW,
  } as unknown as OrchestrationReadModel;
}

it.layer(NodeServices.layer)("gateway lifecycle decider", (it) => {
  it.effect("persists the distinct lifecycle action and attempt identity", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.lifecycle.control",
          commandId: CommandId.make("cmd-pause"),
          threadId: ThreadId.make("thread-1"),
          action: "pause",
          attemptId: "attempt-pause-1",
          messageId: MessageId.make("message-pause-1"),
          createdAt: NOW,
        },
        readModel: readModel("running"),
      } as never);

      expect(event).toMatchObject({
        type: "thread.activity-appended",
        payload: {
          activity: {
            kind: "lifecycle.pause.requested",
            payload: { action: "pause", attemptId: "attempt-pause-1" },
          },
        },
      });
    }),
  );

  it.effect("rejects pause for a queued message without an active session", () =>
    Effect.gen(function* () {
      const snapshot = readModel("interrupted");
      const thread = snapshot.threads[0]!;
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.lifecycle.control",
          commandId: CommandId.make("queued-pause"),
          threadId: thread.id,
          action: "pause",
          attemptId: "queued-pause",
          messageId: MessageId.make("pause-message"),
          createdAt: NOW,
        },
        readModel: {
          ...snapshot,
          threads: [
            {
              ...thread,
              latestTurn: null,
              session: null,
              messages: thread.messages.map((message) => ({ ...message, turnId: null })),
            },
          ],
        },
      } as never).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
    }),
  );

  it.effect("freezes the source user message separately from the new turn message ID", () =>
    Effect.gen(function* () {
      const model = readModel("interrupted");
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.lifecycle.control",
          commandId: CommandId.make("retry-source"),
          threadId: ThreadId.make("thread-1"),
          action: "retry",
          attemptId: "retry-source",
          messageId: MessageId.make("new-retry-message"),
          createdAt: NOW,
        },
        readModel: model,
      } as never);
      expect(result).toMatchObject({
        payload: {
          activity: {
            payload: {
              messageId: "new-retry-message",
              sourceMessageId: model.threads[0]!.messages[0]!.id,
            },
          },
        },
      });
    }),
  );
  it.effect("rejects resume unless the thread is interrupted", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.lifecycle.control",
          commandId: CommandId.make("cmd-resume"),
          threadId: ThreadId.make("thread-1"),
          action: "resume",
          attemptId: "attempt-resume-1",
          messageId: MessageId.make("message-resume-1"),
          createdAt: NOW,
        },
        readModel: readModel("running"),
      } as never).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
    }),
  );
});
