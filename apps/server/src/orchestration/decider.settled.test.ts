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
  session: OrchestrationSession | null = null,
  activities: OrchestrationThread["activities"] = [],
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
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt,
        settledOverride,
        settledAt: settledOverride === "settled" ? SETTLED_AT : null,
        deletedAt: null,
        messages,
        queuedMessages: [],
        proposedPlans: [],
        activities,
        checkpoints: [],
        session,
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
        // updatedAt must NOT rewind to the historical settledAt: sorting and
        // relative-time labels key on it.
        expect(reEmitEvents[0].payload.updatedAt).not.toBe(SETTLED_AT);
      }
    }),
  );

  it.effect("rejects settling a thread with a live session", () =>
    Effect.gen(function* () {
      for (const status of ["starting", "running"] as const) {
        const error = yield* decideOrchestrationCommand({
          command: {
            type: "thread.settle",
            commandId: CommandId.make(`cmd-settle-live-${status}`),
            threadId: ThreadId.make("thread-1"),
          },
          readModel: makeReadModel(null, null, makeSession(status)),
        }).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
      }
      // Stopped/error sessions are settleable — only live work is protected.
      const settled = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-stopped"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, makeSession("stopped")),
      });
      const settledEvents = Array.isArray(settled) ? settled : [settled];
      expect(settledEvents[0]?.type).toBe("thread.settled");
    }),
  );

  it.effect("rejects settling a thread with an open approval or user-input request", () =>
    Effect.gen(function* () {
      const requestActivity = (kind: string, requestId: string, at: string) =>
        ({
          id: EventId.make(`activity-${requestId}-${kind}`),
          tone: "approval" as const,
          kind,
          summary: kind,
          payload: { requestId },
          turnId: null,
          createdAt: at,
        }) as OrchestrationThread["activities"][number];

      // Open approval request: settle rejected.
      const openError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-pending"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          requestActivity("approval.requested", "req-1", NOW),
        ]),
      }).pipe(Effect.flip);
      expect(openError._tag).toBe("OrchestrationCommandInvariantError");

      // Same request later resolved: settleable again.
      const settled = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-resolved"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          requestActivity("approval.requested", "req-1", NOW),
          requestActivity("approval.resolved", "req-1", NOW),
        ]),
      });
      const settledEvents = Array.isArray(settled) ? settled : [settled];
      expect(settledEvents[0]?.type).toBe("thread.settled");

      // Open user-input request: also rejected.
      const inputError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-pending-input"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          requestActivity("user-input.requested", "req-2", NOW),
        ]),
      }).pipe(Effect.flip);
      expect(inputError._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("clears an open request when its respond failure marks it stale", () =>
    Effect.gen(function* () {
      const activity = (
        kind: string,
        requestId: string,
        payload: Record<string, unknown>,
      ): OrchestrationThread["activities"][number] =>
        ({
          id: EventId.make(`activity-${requestId}-${kind}`),
          tone: "approval" as const,
          kind,
          summary: kind,
          payload: { requestId, ...payload },
          turnId: null,
          createdAt: NOW,
        }) as OrchestrationThread["activities"][number];

      // Stale-failure detail clears the request — mirrors the projection's
      // pending accounting, which is what the client's canSettle sees.
      const settled = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-stale-failed"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          activity("approval.requested", "req-1", {}),
          activity("provider.approval.respond.failed", "req-1", {
            detail: "Unknown pending approval request req-1",
          }),
          activity("user-input.requested", "req-2", {}),
          activity("provider.user-input.respond.failed", "req-2", {
            detail: "stale pending user-input request req-2",
          }),
        ]),
      });
      const settledEvents = Array.isArray(settled) ? settled : [settled];
      expect(settledEvents[0]?.type).toBe("thread.settled");

      // A non-stale respond failure (transient provider error) keeps the
      // request open: the user can retry, so it is still blocked-on-you.
      const stillOpen = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-transient-failed"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          activity("approval.requested", "req-3", {}),
          activity("provider.approval.respond.failed", "req-3", {
            detail: "provider connection reset",
          }),
        ]),
      }).pipe(Effect.flip);
      expect(stillOpen._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("bounds the queued-turn grace window against client clock skew", () =>
    Effect.gen(function* () {
      const userMessage = (createdAt: string): OrchestrationThread["messages"][number] => ({
        id: MessageId.make("message-queued"),
        role: "user",
        text: "Continue",
        turnId: null,
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      });

      // The decider's clock is the Effect test clock, pinned to the epoch:
      // timestamps here are relative to 1970-01-01T00:00:00.000Z.

      // Within the grace window: genuinely queued, settle rejected.
      const queuedError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-queued"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [], [userMessage("1969-12-31T23:59:30.000Z")]),
      }).pipe(Effect.flip);
      expect(queuedError._tag).toBe("OrchestrationCommandInvariantError");

      // Message timestamp far in the FUTURE (client clock ahead of server):
      // a negative age must not read as queued forever — past the grace
      // bound in either direction the thread is settleable.
      const skewed = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-skewed"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [], [userMessage("1970-01-01T01:00:00.000Z")]),
      });
      const skewedEvents = Array.isArray(skewed) ? skewed : [skewed];
      expect(skewedEvents[0]?.type).toBe("thread.settled");
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
        // A keep-active pin is also an override: real activity clears it
        // back to neutral so auto-settle can apply again later.
        readModel: makeReadModel("active"),
      });
      const sessionEvents = Array.isArray(sessionResult) ? sessionResult : [sessionResult];
      expect(sessionEvents.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.session-set",
      ]);
    }),
  );

  it.effect("clears a keep-active pin on real activity", () =>
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
      // The pin exists to suppress AUTO-settle, not to survive real work:
      // activity resets it to neutral, restoring the default lifecycle.
      expect(turnEvents.map((event) => event.type)).toEqual([
        "thread.unsettled",
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
      expect(activityEvents.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.activity-appended",
      ]);
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
