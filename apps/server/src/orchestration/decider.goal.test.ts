import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel } from "./projector.ts";

const now = "2026-07-22T00:00:00.000Z";
const threadId = ThreadId.make("thread-goal");
const thread: OrchestrationThread = {
  id: threadId,
  projectId: ProjectId.make("project-goal"),
  title: "New thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

it.layer(NodeServices.layer)("goal decider", (it) => {
  it.effect("sets the goal before starting its first turn", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("command-goal-start"),
          threadId,
          message: {
            messageId: MessageId.make("message-goal-start"),
            role: "user",
            text: "Ship goal support",
            attachments: [],
          },
          goal: { objective: "Ship goal support", tokenBudget: 50_000 },
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-4-6",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
        readModel: { ...createEmptyReadModel(now), threads: [thread] },
      });

      expect(Array.isArray(result)).toBe(true);
      if (!Array.isArray(result)) return;
      expect(result.map((event) => event.type)).toEqual([
        "thread.goal-set-requested",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      const goalEvent = result[0];
      if (goalEvent?.type !== "thread.goal-set-requested") return;
      expect(goalEvent.payload).toMatchObject({
        threadId,
        objective: "Ship goal support",
        status: "active",
        tokenBudget: 50_000,
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
      });
    }),
  );
});
