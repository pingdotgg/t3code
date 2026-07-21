import {
  CommandId,
  EventId,
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
const SETTLED_AT = "2025-12-30T00:00:00.000Z";

function makeReadModel(
  settledOverride: OrchestrationThread["settledOverride"],
  archivedAt: string | null = null,
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
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt,
        settledOverride,
        settledAt: settledOverride === "settled" ? SETTLED_AT : null,
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

function makeSession(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: ThreadId.make("thread-1"),
    status,
    providerName: "Codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("settled thread decider", (it) => {
  it.effect("settles active threads and re-emits idempotently for settled ones", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.settled");
      if (events[0]?.type === "thread.settled") {
        expect(events[0].payload.settledAt).toBe(events[0].payload.updatedAt);
      }

      // Already settled: the engine rejects zero-event commands, so idempotency
      // is by re-emission — preserving the original settledAt.
      const reEmit = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-again"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel("settled"),
      });
      const reEmitEvents = Array.isArray(reEmit) ? reEmit : [reEmit];
      expect(reEmitEvents).toHaveLength(1);
      expect(reEmitEvents[0]?.type).toBe("thread.settled");
      if (reEmitEvents[0]?.type === "thread.settled") {
        expect(reEmitEvents[0].payload.settledAt).toBe(SETTLED_AT);
        expect(reEmitEvents[0].payload.updatedAt).toBe(SETTLED_AT);
      }
    }),
  );

  it.effect("rejects settling and unsettling archived threads", () =>
    Effect.gen(function* () {
      const settleError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-archived"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, NOW),
      }).pipe(Effect.flip);
      expect(settleError._tag).toBe("OrchestrationCommandInvariantError");

      const unsettleError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unsettle",
          commandId: CommandId.make("cmd-unsettle-archived"),
          threadId: ThreadId.make("thread-1"),
          reason: "user",
        },
        readModel: makeReadModel("settled", NOW),
      }).pipe(Effect.flip);
      expect(unsettleError._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("maps unsettle reasons to overrides and re-emits idempotently", () =>
    Effect.gen(function* () {
      const userEvent = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unsettle",
          commandId: CommandId.make("cmd-unsettle-user"),
          threadId: ThreadId.make("thread-1"),
          reason: "user",
        },
        readModel: makeReadModel("settled"),
      });
      const userEvents = Array.isArray(userEvent) ? userEvent : [userEvent];
      expect(userEvents).toHaveLength(1);
      expect(userEvents[0]?.type).toBe("thread.unsettled");
      if (userEvents[0]?.type === "thread.unsettled") {
        expect(userEvents[0].payload.reason).toBe("user");
      }

      // Re-dispatching against the already-reached state re-emits rather than
      // producing zero events (the engine rejects empty commands).
      const userAgain = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unsettle",
          commandId: CommandId.make("cmd-unsettle-user-again"),
          threadId: ThreadId.make("thread-1"),
          reason: "user",
        },
        readModel: makeReadModel("active"),
      });
      const userAgainEvents = Array.isArray(userAgain) ? userAgain : [userAgain];
      expect(userAgainEvents).toHaveLength(1);
      expect(userAgainEvents[0]?.type).toBe("thread.unsettled");
    }),
  );

  it.effect("prepends activity unsets for turn starts and live session updates", () =>
    Effect.gen(function* () {
      const turnResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-1"),
            role: "user",
            text: "Continue",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel("settled"),
      });
      const turnEvents = Array.isArray(turnResult) ? turnResult : [turnResult];
      expect(turnEvents.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);

      const sessionResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set"),
          threadId: ThreadId.make("thread-1"),
          session: makeSession("running"),
          createdAt: NOW,
        },
        readModel: makeReadModel("active"),
      });
      const sessionEvents = Array.isArray(sessionResult) ? sessionResult : [sessionResult];
      expect(sessionEvents.map((event) => event.type)).toEqual(["thread.session-set"]);
    }),
  );

  it.effect("preserves an explicit active override during activity", () =>
    Effect.gen(function* () {
      const turnResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-active-turn-start"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-active"),
            role: "user",
            text: "Continue",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel("active"),
      });
      const turnEvents = Array.isArray(turnResult) ? turnResult : [turnResult];
      expect(turnEvents.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);

      const activityResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-active-approval"),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-active"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: null,
            turnId: null,
            createdAt: NOW,
          },
          createdAt: NOW,
        },
        readModel: makeReadModel("active"),
      });
      const activityEvents = Array.isArray(activityResult) ? activityResult : [activityResult];
      expect(activityEvents.map((event) => event.type)).toEqual(["thread.activity-appended"]);
    }),
  );

  it.effect("does not unsettle for session stop/error status writes", () =>
    Effect.gen(function* () {
      for (const status of ["stopped", "error", "ready", "idle"] as const) {
        const result = yield* decideOrchestrationCommand({
          command: {
            type: "thread.session.set",
            commandId: CommandId.make(`cmd-session-${status}`),
            threadId: ThreadId.make("thread-1"),
            session: makeSession(status),
            createdAt: NOW,
          },
          readModel: makeReadModel("settled"),
        });
        const events = Array.isArray(result) ? result : [result];
        expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
      }
    }),
  );

  it.effect("unsettles for approval and user-input activities but not others", () =>
    Effect.gen(function* () {
      const approvalResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-activity-approval"),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-1"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: null,
            turnId: null,
            createdAt: NOW,
          },
          createdAt: NOW,
        },
        readModel: makeReadModel("settled"),
      });
      const approvalEvents = Array.isArray(approvalResult) ? approvalResult : [approvalResult];
      expect(approvalEvents.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.activity-appended",
      ]);

      const routineResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-activity-routine"),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-2"),
            tone: "info",
            kind: "tool.completed",
            summary: "Tool completed",
            payload: null,
            turnId: null,
            createdAt: NOW,
          },
          createdAt: NOW,
        },
        readModel: makeReadModel("settled"),
      });
      const routineEvents = Array.isArray(routineResult) ? routineResult : [routineResult];
      expect(routineEvents.map((event) => event.type)).toEqual(["thread.activity-appended"]);
    }),
  );
});
