import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeReadModel(
  status: OrchestrationSession["status"] | null,
  messages: OrchestrationThread["messages"] = [],
): OrchestrationReadModel {
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
        worktreePath: null,
        pullRequests: [],
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
        messages,
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session:
          status === null
            ? null
            : {
                threadId: ThreadId.make("thread-1"),
                status,
                providerName: "Codex",
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: null,
                updatedAt: NOW,
              },
      },
    ],
    updatedAt: NOW,
  };
}

const revert = (type: "thread.checkpoint.revert" | "thread.conversation.revert") => ({
  type,
  commandId: CommandId.make(`cmd-${type}`),
  threadId: ThreadId.make("thread-1"),
  turnCount: 1,
  createdAt: NOW,
});

it.layer(NodeServices.layer)("revert decider", (it) => {
  it.effect("rejects a revert while the session is starting or running", () =>
    Effect.gen(function* () {
      for (const type of ["thread.checkpoint.revert", "thread.conversation.revert"] as const) {
        for (const status of ["starting", "running"] as const) {
          const error = yield* decideOrchestrationCommand({
            command: revert(type),
            readModel: makeReadModel(status),
          }).pipe(Effect.flip);
          expect(error).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
        }
      }
    }),
  );

  it.effect("rejects a revert while a sent message has not started its turn yet", () =>
    Effect.gen(function* () {
      // The decider's clock is the Effect test clock, pinned to the epoch, so
      // this message was sent 30 seconds ago and no turn has picked it up.
      const justSent: OrchestrationThread["messages"][number] = {
        id: MessageId.make("message-queued"),
        role: "user",
        text: "Continue",
        turnId: null,
        streaming: false,
        createdAt: "1969-12-31T23:59:30.000Z",
        updatedAt: "1969-12-31T23:59:30.000Z",
      };
      const error = yield* decideOrchestrationCommand({
        command: revert("thread.checkpoint.revert"),
        readModel: makeReadModel("ready", [justSent]),
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
    }),
  );

  it.effect("accepts a revert when no turn is running", () =>
    Effect.gen(function* () {
      for (const status of [null, "ready", "stopped", "error"] as const) {
        const result = yield* decideOrchestrationCommand({
          command: revert("thread.checkpoint.revert"),
          readModel: makeReadModel(status),
        });
        const events = Array.isArray(result) ? result : [result];
        expect(events.map((event) => event.type)).toEqual(["thread.checkpoint-revert-requested"]);
      }
    }),
  );
});
