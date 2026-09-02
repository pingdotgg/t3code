import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const FIRST_ATTEMPT = "1970-01-01T00:05:00.000Z";
const SECOND_ATTEMPT = "1970-01-01T00:20:00.000Z";
const USAGE_LIMIT_SESSION = {
  threadId: ThreadId.make("thread-1"),
  status: "error" as const,
  providerName: "codex",
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: "Usage limit reached",
  lastErrorClass: "usage_limit" as const,
  updatedAt: NOW,
};

function makeReadModel(
  usageLimitResume: OrchestrationThread["usageLimitResume"] = null,
  settledOverride: OrchestrationThread["settledOverride"] = null,
  archivedAt: string | null = null,
  deletedAt: string | null = null,
  session: OrchestrationThread["session"] = USAGE_LIMIT_SESSION,
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
        settledAt: settledOverride === "settled" ? NOW : null,
        usageLimitResume,
        deletedAt,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("usage-limit resume decider", (it) => {
  it.effect("schedules, attempts, and paces a retry", () =>
    Effect.gen(function* () {
      const scheduled = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-resume.schedule",
          commandId: CommandId.make("cmd-schedule"),
          threadId: ThreadId.make("thread-1"),
          resumeAt: FIRST_ATTEMPT,
        },
        readModel: makeReadModel(),
      });
      const scheduledEvents = Array.isArray(scheduled) ? scheduled : [scheduled];
      const scheduledEvent = scheduledEvents[0];
      expect(scheduledEvents).toHaveLength(1);
      if (scheduledEvent?.type !== "thread.usage-limit-resume-scheduled") {
        return;
      }
      expect(scheduledEvent.payload).toMatchObject({ resumeAt: FIRST_ATTEMPT, attempt: 0 });

      const attempted = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-resume.attempt",
          commandId: CommandId.make("cmd-attempt"),
          threadId: ThreadId.make("thread-1"),
          expectedAttemptAt: FIRST_ATTEMPT,
          createdAt: FIRST_ATTEMPT,
        },
        readModel: makeReadModel({ nextAttemptAt: FIRST_ATTEMPT, attempt: 0 }),
      });
      const attemptedEvents = Array.isArray(attempted) ? attempted : [attempted];
      const attemptedEvent = attemptedEvents[0];
      expect(attemptedEvents).toHaveLength(1);
      if (attemptedEvent?.type !== "thread.usage-limit-resume-attempted") {
        return;
      }
      expect(attemptedEvent.payload.shouldResume).toBe(true);

      const retried = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-resume.retry",
          commandId: CommandId.make("cmd-retry"),
          threadId: ThreadId.make("thread-1"),
          resumeAt: SECOND_ATTEMPT,
          attempt: 0,
          createdAt: FIRST_ATTEMPT,
        },
        readModel: makeReadModel({ nextAttemptAt: null, attempt: 0 }),
      });
      const retriedEvents = Array.isArray(retried) ? retried : [retried];
      const retriedEvent = retriedEvents[0];
      expect(retriedEvents).toHaveLength(1);
      if (retriedEvent?.type !== "thread.usage-limit-resume-scheduled") {
        return;
      }
      expect(retriedEvent.payload).toMatchObject({ resumeAt: SECOND_ATTEMPT, attempt: 1 });
    }),
  );

  it.effect("ignores a stale timer and clears automatic resume on a manual turn", () =>
    Effect.gen(function* () {
      const staleAttempt = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-resume.attempt",
          commandId: CommandId.make("cmd-stale"),
          threadId: ThreadId.make("thread-1"),
          expectedAttemptAt: FIRST_ATTEMPT,
          createdAt: SECOND_ATTEMPT,
        },
        readModel: makeReadModel({ nextAttemptAt: SECOND_ATTEMPT, attempt: 1 }),
      });
      const staleEvents = Array.isArray(staleAttempt) ? staleAttempt : [staleAttempt];
      const staleEvent = staleEvents[0];
      expect(staleEvents).toHaveLength(1);
      if (staleEvent?.type !== "thread.usage-limit-resume-attempted") {
        return;
      }
      expect(staleEvent.payload.shouldResume).toBe(false);

      const manualTurn = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-manual-turn"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-1"),
            role: "user",
            text: "Try now",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel({ nextAttemptAt: SECOND_ATTEMPT, attempt: 1 }),
      });
      const events = Array.isArray(manualTurn) ? manualTurn : [manualTurn];
      expect(events.some((event) => event.type === "thread.usage-limit-resume-cancelled")).toBe(
        true,
      );
      expect(events.some((event) => event.type === "thread.turn-start-requested")).toBe(true);
    }),
  );

  it.effect("requires a usage limit to schedule and only cancels attempts for active work", () =>
    Effect.gen(function* () {
      const runningSession: OrchestrationThread["session"] = {
        threadId: ThreadId.make("thread-1"),
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: NOW,
      };
      const scheduleError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-resume.schedule",
          commandId: CommandId.make("cmd-running-schedule"),
          threadId: ThreadId.make("thread-1"),
          resumeAt: FIRST_ATTEMPT,
        },
        readModel: makeReadModel(null, null, null, null, runningSession),
      }).pipe(Effect.flip);
      expect(scheduleError._tag).toBe("OrchestrationCommandInvariantError");

      const attempted = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-resume.attempt",
          commandId: CommandId.make("cmd-running-attempt"),
          threadId: ThreadId.make("thread-1"),
          expectedAttemptAt: FIRST_ATTEMPT,
          createdAt: FIRST_ATTEMPT,
        },
        readModel: makeReadModel(
          { nextAttemptAt: FIRST_ATTEMPT, attempt: 0 },
          null,
          null,
          null,
          runningSession,
        ),
      });
      const attemptedEvents = Array.isArray(attempted) ? attempted : [attempted];
      expect(attemptedEvents.map((event) => event.type)).toEqual([
        "thread.usage-limit-resume-cancelled",
      ]);

      const readySession: OrchestrationThread["session"] = {
        ...runningSession,
        status: "ready",
      };
      const metadataClearedAttempt = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-resume.attempt",
          commandId: CommandId.make("cmd-metadata-cleared-attempt"),
          threadId: ThreadId.make("thread-1"),
          expectedAttemptAt: FIRST_ATTEMPT,
          createdAt: FIRST_ATTEMPT,
        },
        readModel: makeReadModel(
          { nextAttemptAt: FIRST_ATTEMPT, attempt: 0 },
          null,
          null,
          null,
          readySession,
        ),
      });
      const metadataClearedEvents = Array.isArray(metadataClearedAttempt)
        ? metadataClearedAttempt
        : [metadataClearedAttempt];
      expect(metadataClearedEvents[0]).toMatchObject({
        type: "thread.usage-limit-resume-attempted",
        payload: { shouldResume: true },
      });
    }),
  );

  it.effect("clears automatic resume on settlement and rejects a settled timer", () =>
    Effect.gen(function* () {
      const scheduleError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-resume.schedule",
          commandId: CommandId.make("cmd-settled-schedule"),
          threadId: ThreadId.make("thread-1"),
          resumeAt: FIRST_ATTEMPT,
        },
        readModel: makeReadModel(null, "settled"),
      }).pipe(Effect.flip);
      expect(scheduleError._tag).toBe("OrchestrationCommandInvariantError");

      const settled = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ nextAttemptAt: FIRST_ATTEMPT, attempt: 0 }),
      });
      const settledEvents = Array.isArray(settled) ? settled : [settled];
      expect(settledEvents.map((event) => event.type)).toEqual([
        "thread.settled",
        "thread.usage-limit-resume-cancelled",
      ]);

      const settledInFlight = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-in-flight"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ nextAttemptAt: null, attempt: 0 }),
      });
      const settledInFlightEvents = Array.isArray(settledInFlight)
        ? settledInFlight
        : [settledInFlight];
      expect(settledInFlightEvents.map((event) => event.type)).toEqual([
        "thread.settled",
        "thread.usage-limit-resume-cancelled",
        "thread.turn-interrupt-requested",
      ]);

      const attempted = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-resume.attempt",
          commandId: CommandId.make("cmd-settled-attempt"),
          threadId: ThreadId.make("thread-1"),
          expectedAttemptAt: FIRST_ATTEMPT,
          createdAt: FIRST_ATTEMPT,
        },
        readModel: makeReadModel({ nextAttemptAt: FIRST_ATTEMPT, attempt: 0 }, "settled"),
      });
      const attemptedEvents = Array.isArray(attempted) ? attempted : [attempted];
      expect(attemptedEvents).toHaveLength(1);
      expect(attemptedEvents[0]?.type).toBe("thread.usage-limit-resume-cancelled");

      const retried = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-resume.retry",
          commandId: CommandId.make("cmd-settled-retry"),
          threadId: ThreadId.make("thread-1"),
          resumeAt: SECOND_ATTEMPT,
          attempt: 0,
          createdAt: FIRST_ATTEMPT,
        },
        readModel: makeReadModel({ nextAttemptAt: null, attempt: 0 }, "settled"),
      });
      const retriedEvents = Array.isArray(retried) ? retried : [retried];
      expect(retriedEvents).toHaveLength(1);
      expect(retriedEvents[0]?.type).toBe("thread.usage-limit-resume-cancelled");
    }),
  );

  it.effect("rejects scheduling and timers after a thread is deleted", () =>
    Effect.gen(function* () {
      const scheduleError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-resume.schedule",
          commandId: CommandId.make("cmd-deleted-schedule"),
          threadId: ThreadId.make("thread-1"),
          resumeAt: FIRST_ATTEMPT,
        },
        readModel: makeReadModel(null, null, null, NOW),
      }).pipe(Effect.flip);
      expect(scheduleError._tag).toBe("OrchestrationCommandInvariantError");

      const deleted = yield* decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: CommandId.make("cmd-delete-in-flight-resume"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ nextAttemptAt: null, attempt: 0 }),
      });
      const deletedEvents = Array.isArray(deleted) ? deleted : [deleted];
      expect(deletedEvents.map((event) => event.type)).toEqual([
        "thread.usage-limit-resume-cancelled",
        "thread.turn-interrupt-requested",
        "thread.deleted",
      ]);

      const attempted = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-resume.attempt",
          commandId: CommandId.make("cmd-deleted-attempt"),
          threadId: ThreadId.make("thread-1"),
          expectedAttemptAt: FIRST_ATTEMPT,
          createdAt: FIRST_ATTEMPT,
        },
        readModel: makeReadModel({ nextAttemptAt: FIRST_ATTEMPT, attempt: 0 }, null, null, NOW),
      });
      const attemptedEvents = Array.isArray(attempted) ? attempted : [attempted];
      expect(attemptedEvents).toHaveLength(1);
      expect(attemptedEvents[0]?.type).toBe("thread.usage-limit-resume-cancelled");
    }),
  );

  it.effect("cancels automatic resume when a thread is archived or interrupted", () =>
    Effect.gen(function* () {
      const archived = yield* decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: CommandId.make("cmd-archive-resume"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ nextAttemptAt: FIRST_ATTEMPT, attempt: 2 }),
      });
      const archivedEvents = Array.isArray(archived) ? archived : [archived];
      expect(archivedEvents.map((event) => event.type)).toEqual([
        "thread.usage-limit-resume-cancelled",
        "thread.archived",
      ]);

      const archivedInFlight = yield* decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: CommandId.make("cmd-archive-in-flight-resume"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ nextAttemptAt: null, attempt: 2 }),
      });
      const archivedInFlightEvents = Array.isArray(archivedInFlight)
        ? archivedInFlight
        : [archivedInFlight];
      expect(archivedInFlightEvents.map((event) => event.type)).toEqual([
        "thread.usage-limit-resume-cancelled",
        "thread.turn-interrupt-requested",
        "thread.archived",
      ]);

      const interrupted = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.interrupt",
          commandId: CommandId.make("cmd-interrupt-resume"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
        },
        readModel: makeReadModel({ nextAttemptAt: null, attempt: 2 }),
      });
      const interruptedEvents = Array.isArray(interrupted) ? interrupted : [interrupted];
      expect(interruptedEvents.map((event) => event.type)).toEqual([
        "thread.usage-limit-resume-cancelled",
        "thread.turn-interrupt-requested",
      ]);
    }),
  );

  it.effect("rejects archived timers and clears legacy resume state on unarchive", () =>
    Effect.gen(function* () {
      const archivedReadModel = makeReadModel(
        { nextAttemptAt: FIRST_ATTEMPT, attempt: 2 },
        null,
        NOW,
      );
      const attemptError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-resume.attempt",
          commandId: CommandId.make("cmd-archived-attempt"),
          threadId: ThreadId.make("thread-1"),
          expectedAttemptAt: FIRST_ATTEMPT,
          createdAt: FIRST_ATTEMPT,
        },
        readModel: archivedReadModel,
      }).pipe(Effect.flip);
      expect(attemptError._tag).toBe("OrchestrationCommandInvariantError");

      const unarchived = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unarchive",
          commandId: CommandId.make("cmd-unarchive-resume"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: archivedReadModel,
      });
      const unarchivedEvents = Array.isArray(unarchived) ? unarchived : [unarchived];
      expect(unarchivedEvents.map((event) => event.type)).toEqual([
        "thread.usage-limit-resume-cancelled",
        "thread.unarchived",
      ]);

      const retried = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-resume.retry",
          commandId: CommandId.make("cmd-archived-retry"),
          threadId: ThreadId.make("thread-1"),
          resumeAt: SECOND_ATTEMPT,
          attempt: 2,
          createdAt: FIRST_ATTEMPT,
        },
        readModel: makeReadModel({ nextAttemptAt: null, attempt: 2 }, null, NOW),
      });
      const retriedEvents = Array.isArray(retried) ? retried : [retried];
      expect(retriedEvents.map((event) => event.type)).toEqual([
        "thread.usage-limit-resume-cancelled",
      ]);
    }),
  );
});
