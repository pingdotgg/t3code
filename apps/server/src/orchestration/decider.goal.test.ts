import {
  CommandId,
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
  settledOverride: null,
  settledAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

it.layer(NodeServices.layer)("goal decider", (it) => {
  it.effect("requests a goal with the selected provider without starting a normal turn", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.make("command-goal-start"),
          threadId,
          objective: "Ship goal support",
          status: "active",
          tokenBudget: 50_000,
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-4-6",
          },
          createdAt: now,
        },
        readModel: { ...createEmptyReadModel(now), threads: [thread] },
      });

      expect("type" in result).toBe(true);
      if (!("type" in result) || result.type !== "thread.goal-set-requested") return;
      expect(result.payload).toMatchObject({
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

  it.effect("wakes settled threads for goal requests and provider goal sync", () =>
    Effect.gen(function* () {
      const setResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.make("command-goal-settled-start"),
          threadId,
          objective: "Ship goal support",
          status: "active",
          createdAt: now,
        },
        readModel: {
          ...createEmptyReadModel(now),
          threads: [{ ...thread, settledOverride: "settled", settledAt: now }],
        },
      });
      const setEvents = Array.isArray(setResult) ? setResult : [setResult];
      expect(setEvents.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.goal-set-requested",
      ]);

      const syncResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.sync",
          commandId: CommandId.make("command-goal-active-sync"),
          threadId,
          goal: {
            objective: "Ship goal support",
            status: "active",
            tokenBudget: null,
            tokensUsed: 100,
            timeUsedSeconds: 10,
            createdAt: now,
            updatedAt: now,
          },
          createdAt: now,
        },
        readModel: {
          ...createEmptyReadModel(now),
          threads: [{ ...thread, settledOverride: "active" }],
        },
      });
      const syncEvents = Array.isArray(syncResult) ? syncResult : [syncResult];
      expect(syncEvents.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.goal-updated",
      ]);
    }),
  );
});
