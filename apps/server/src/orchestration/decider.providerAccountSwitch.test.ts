import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");
const claudeWork = ProviderInstanceId.make("claude_work");
const claudePersonal = ProviderInstanceId.make("claude_personal");

function makeReadModel(
  session: OrchestrationSession | null,
  activities: OrchestrationThread["activities"] = [],
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: claudeWork, model: "claude-model" },
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
        messages: [],
        proposedPlans: [],
        activities,
        checkpoints: [],
        session,
      },
    ],
    updatedAt: NOW,
  };
}

function makeSession(input: {
  readonly instanceId: ProviderInstanceId;
  readonly status: OrchestrationSession["status"];
  readonly activeTurnId?: TurnId;
}): OrchestrationSession {
  return {
    threadId,
    status: input.status,
    providerName: "claudeAgent",
    providerInstanceId: input.instanceId,
    runtimeMode: "full-access",
    activeTurnId: input.activeTurnId ?? null,
    lastError: null,
    updatedAt: NOW,
  };
}

const command = {
  type: "thread.provider-account.switch" as const,
  commandId: CommandId.make("cmd-switch"),
  threadId,
  fromInstanceId: claudeWork,
  modelSelection: { instanceId: claudePersonal, model: "claude-model" },
  createdAt: NOW,
};

it.layer(NodeServices.layer)("provider account switch decider", (it) => {
  it.effect("requests the switch for an idle thread on the named account", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel(makeSession({ instanceId: claudeWork, status: "ready" })),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "thread.provider-account-switch-requested",
        payload: {
          threadId,
          fromInstanceId: claudeWork,
          modelSelection: command.modelSelection,
          createdAt: NOW,
        },
      });
    }),
  );

  it.effect("rejects a switch that names an account the thread has already left", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel(makeSession({ instanceId: claudePersonal, status: "ready" })),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("Select the account again");
    }),
  );

  it.effect("rejects a switch to the account the thread already uses", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: { ...command, modelSelection: { instanceId: claudeWork, model: "other-model" } },
        readModel: makeReadModel(makeSession({ instanceId: claudeWork, status: "ready" })),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("already uses");
    }),
  );

  it.effect("rejects a switch while a turn is running", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel(
          makeSession({
            instanceId: claudeWork,
            status: "running",
            activeTurnId: TurnId.make("turn-1"),
          }),
        ),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("still working");
    }),
  );

  it.effect("rejects a switch while the session reports running without a turn id", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel(makeSession({ instanceId: claudeWork, status: "running" })),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("still working");
    }),
  );

  it.effect("rejects a switch while an approval is waiting on the user", () =>
    Effect.gen(function* () {
      const requestActivity = {
        id: EventId.make("activity-req-1"),
        tone: "approval" as const,
        kind: "approval.requested",
        summary: "approval.requested",
        payload: { requestId: "req-1" },
        turnId: null,
        createdAt: NOW,
      } as OrchestrationThread["activities"][number];
      const error = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel(makeSession({ instanceId: claudeWork, status: "ready" }), [
          requestActivity,
        ]),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("still working");
    }),
  );
});
