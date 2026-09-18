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

import { AUTO_CONTINUE_MESSAGE_TEXT, decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
// The decider's clock is the Effect test clock, pinned to the epoch, so
// "future" resume times are relative to 1970-01-01T00:00:00.000Z.
const FUTURE_RESET = "1970-01-01T05:00:00.000Z";
const DUE_RESET = "1969-12-31T21:00:00.000Z";

function makeReadModel(input: {
  readonly autoContinueAt?: string | null;
  readonly archivedAt?: string | null;
  readonly settledOverride?: "settled" | "active" | null;
  readonly settledAt?: string | null;
}): OrchestrationReadModel {
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
        archivedAt: input.archivedAt ?? null,
        settledOverride: input.settledOverride ?? null,
        settledAt: input.settledAt ?? null,
        snoozedUntil: null,
        snoozedAt: null,
        autoContinueAt: input.autoContinueAt ?? null,
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

it.layer(NodeServices.layer)("auto-continue decider", (it) => {
  it.effect("schedules a continuation for a future reset time", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.auto-continue.set",
          commandId: CommandId.make("cmd-ac-set"),
          threadId: ThreadId.make("thread-1"),
          autoContinueAt: FUTURE_RESET,
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.auto-continue-scheduled");
      if (events[0]?.type === "thread.auto-continue-scheduled") {
        expect(events[0].payload.autoContinueAt).toBe(FUTURE_RESET);
      }
    }),
  );

  it.effect("rejects a resume time that is not in the future", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.auto-continue.set",
          commandId: CommandId.make("cmd-ac-set-past"),
          threadId: ThreadId.make("thread-1"),
          autoContinueAt: DUE_RESET,
        },
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects an unparseable resume time", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.auto-continue.set",
          commandId: CommandId.make("cmd-ac-set-garbage"),
          threadId: ThreadId.make("thread-1"),
          autoContinueAt: "not-a-date",
        },
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("re-emits idempotently for a duplicate schedule to the same instant", () =>
    Effect.gen(function* () {
      const reEmit = yield* decideOrchestrationCommand({
        command: {
          type: "thread.auto-continue.set",
          commandId: CommandId.make("cmd-ac-set-again"),
          threadId: ThreadId.make("thread-1"),
          autoContinueAt: FUTURE_RESET,
        },
        readModel: makeReadModel({ autoContinueAt: FUTURE_RESET }),
      });
      const events = Array.isArray(reEmit) ? reEmit : [reEmit];
      expect(events).toHaveLength(1);
      if (events[0]?.type === "thread.auto-continue-scheduled") {
        // No state change — keep the existing updatedAt.
        expect(events[0].payload.updatedAt).toBe(NOW);
      }
    }),
  );

  it.effect("clears with reason user and re-emits idempotently when unscheduled", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.auto-continue.clear",
          commandId: CommandId.make("cmd-ac-clear"),
          threadId: ThreadId.make("thread-1"),
          reason: "user",
        },
        readModel: makeReadModel({ autoContinueAt: FUTURE_RESET }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.auto-continue-cleared");
      if (events[0]?.type === "thread.auto-continue-cleared") {
        expect(events[0].payload.reason).toBe("user");
        expect(events[0].payload.updatedAt).not.toBe(NOW);
      }

      const alreadyClear = yield* decideOrchestrationCommand({
        command: {
          type: "thread.auto-continue.clear",
          commandId: CommandId.make("cmd-ac-clear-again"),
          threadId: ThreadId.make("thread-1"),
          reason: "user",
        },
        readModel: makeReadModel({}),
      });
      const clearEvents = Array.isArray(alreadyClear) ? alreadyClear : [alreadyClear];
      expect(clearEvents[0]?.type).toBe("thread.auto-continue-cleared");
      if (clearEvents[0]?.type === "thread.auto-continue-cleared") {
        // No state change — keep the existing updatedAt.
        expect(clearEvents[0].payload.updatedAt).toBe(NOW);
      }
    }),
  );

  it.effect("any turn start spends the schedule (activity clear)", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-1"),
            role: "user",
            text: "Keep going",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel({ autoContinueAt: FUTURE_RESET }),
      });
      const events = Array.isArray(result) ? result : [result];
      const cleared = events.find((entry) => entry.type === "thread.auto-continue-cleared");
      expect(cleared).toBeDefined();
      if (cleared?.type === "thread.auto-continue-cleared") {
        expect(cleared.payload.reason).toBe("activity");
      }
    }),
  );

  it.effect("settling clears a pending continuation", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ autoContinueAt: FUTURE_RESET }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((entry) => entry.type)).toEqual([
        "thread.settled",
        "thread.auto-continue-cleared",
      ]);
    }),
  );

  it.effect("archiving clears a pending continuation", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: CommandId.make("cmd-archive"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ autoContinueAt: FUTURE_RESET }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((entry) => entry.type)).toEqual([
        "thread.archived",
        "thread.auto-continue-cleared",
      ]);
    }),
  );

  it.effect("fires a due continuation as a Continue turn that spends the schedule", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.auto-continue.fire",
          commandId: CommandId.make("server:auto-continue:thread-1:uuid"),
          threadId: ThreadId.make("thread-1"),
          autoContinueAt: DUE_RESET,
          messageId: MessageId.make("message-continue"),
          createdAt: NOW,
        },
        readModel: makeReadModel({ autoContinueAt: DUE_RESET }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((entry) => entry.type)).toEqual([
        "thread.auto-continue-cleared",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      const messageSent = events.find((entry) => entry.type === "thread.message-sent");
      if (messageSent?.type === "thread.message-sent") {
        expect(messageSent.payload.text).toBe(AUTO_CONTINUE_MESSAGE_TEXT);
        expect(messageSent.payload.role).toBe("user");
        expect(messageSent.payload.messageId).toBe("message-continue");
      }
    }),
  );

  it.effect("rejects firing when the schedule changed since the sweep read it", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.auto-continue.fire",
          commandId: CommandId.make("server:auto-continue:thread-1:stale"),
          threadId: ThreadId.make("thread-1"),
          autoContinueAt: DUE_RESET,
          messageId: MessageId.make("message-continue"),
          createdAt: NOW,
        },
        // Cancelled (or rescheduled) after the sweep read the shell.
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects firing a schedule that is not due yet", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.auto-continue.fire",
          commandId: CommandId.make("server:auto-continue:thread-1:early"),
          threadId: ThreadId.make("thread-1"),
          autoContinueAt: FUTURE_RESET,
          messageId: MessageId.make("message-continue"),
          createdAt: NOW,
        },
        readModel: makeReadModel({ autoContinueAt: FUTURE_RESET }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects scheduling on an archived thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.auto-continue.set",
          commandId: CommandId.make("cmd-ac-set-archived"),
          threadId: ThreadId.make("thread-1"),
          autoContinueAt: FUTURE_RESET,
        },
        readModel: makeReadModel({ archivedAt: NOW }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
