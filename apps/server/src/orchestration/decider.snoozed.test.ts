import {
  CommandId,
  EventId,
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
// The decider's clock is the Effect test clock, pinned to the epoch, so
// "future" wake times are relative to 1970-01-01T00:00:00.000Z.
const FUTURE_WAKE = "1970-01-02T09:00:00.000Z";
const PAST_WAKE = "1969-12-31T09:00:00.000Z";
const SNOOZED_AT = "1969-12-30T00:00:00.000Z";

function makeReadModel(input: {
  readonly snoozedUntil?: string | null;
  readonly snoozedAt?: string | null;
  readonly archivedAt?: string | null;
  readonly activities?: OrchestrationThread["activities"];
  readonly messages?: OrchestrationThread["messages"];
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
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: input.archivedAt ?? null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: input.snoozedUntil ?? null,
        snoozedAt: input.snoozedAt ?? (input.snoozedUntil != null ? SNOOZED_AT : null),
        deletedAt: null,
        messages: input.messages ?? [],
        proposedPlans: [],
        activities: input.activities ?? [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("snoozed thread decider", (it) => {
  it.effect("snoozes a thread to a future wake time", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.snooze",
          commandId: CommandId.make("cmd-snooze"),
          threadId: ThreadId.make("thread-1"),
          snoozedUntil: FUTURE_WAKE,
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.snoozed");
      if (events[0]?.type === "thread.snoozed") {
        expect(events[0].payload.snoozedUntil).toBe(FUTURE_WAKE);
        expect(events[0].payload.snoozedAt).toBe(events[0].payload.updatedAt);
      }
    }),
  );

  it.effect("rejects a wake time that is not in the future", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.snooze",
          commandId: CommandId.make("cmd-snooze-past"),
          threadId: ThreadId.make("thread-1"),
          snoozedUntil: PAST_WAKE,
        },
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects an unparseable wake time", () =>
    Effect.gen(function* () {
      // IsoDateTime is structurally a string, so garbage can reach the
      // decider; a NaN wake time must never persist as snooze state.
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.snooze",
          commandId: CommandId.make("cmd-snooze-garbage"),
          threadId: ThreadId.make("thread-1"),
          snoozedUntil: "not-a-date",
        },
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects snoozing blocked-on-you work", () =>
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
        command: {
          type: "thread.snooze",
          commandId: CommandId.make("cmd-snooze-blocked"),
          threadId: ThreadId.make("thread-1"),
          snoozedUntil: FUTURE_WAKE,
        },
        readModel: makeReadModel({ activities: [requestActivity] }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("re-emits idempotently for a duplicate snooze to the same wake time", () =>
    Effect.gen(function* () {
      const reEmit = yield* decideOrchestrationCommand({
        command: {
          type: "thread.snooze",
          commandId: CommandId.make("cmd-snooze-again"),
          threadId: ThreadId.make("thread-1"),
          snoozedUntil: FUTURE_WAKE,
        },
        readModel: makeReadModel({ snoozedUntil: FUTURE_WAKE }),
      });
      const events = Array.isArray(reEmit) ? reEmit : [reEmit];
      expect(events).toHaveLength(1);
      if (events[0]?.type === "thread.snoozed") {
        // Original snoozedAt preserved; updatedAt must not churn.
        expect(events[0].payload.snoozedAt).toBe(SNOOZED_AT);
        expect(events[0].payload.updatedAt).toBe(NOW);
      }
    }),
  );

  it.effect("re-snoozing to a DIFFERENT wake time stamps fresh", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.snooze",
          commandId: CommandId.make("cmd-snooze-extend"),
          threadId: ThreadId.make("thread-1"),
          snoozedUntil: "1970-01-03T09:00:00.000Z",
        },
        readModel: makeReadModel({ snoozedUntil: FUTURE_WAKE }),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.snoozed") {
        expect(events[0].payload.snoozedUntil).toBe("1970-01-03T09:00:00.000Z");
        expect(events[0].payload.updatedAt).not.toBe(NOW);
      }
    }),
  );

  it.effect("unsnoozes with reason user and re-emits idempotently when awake", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unsnooze",
          commandId: CommandId.make("cmd-unsnooze"),
          threadId: ThreadId.make("thread-1"),
          reason: "user",
        },
        readModel: makeReadModel({ snoozedUntil: FUTURE_WAKE }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.unsnoozed");
      if (events[0]?.type === "thread.unsnoozed") {
        expect(events[0].payload.reason).toBe("user");
        expect(events[0].payload.updatedAt).not.toBe(NOW);
      }

      const awake = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unsnooze",
          commandId: CommandId.make("cmd-unsnooze-awake"),
          threadId: ThreadId.make("thread-1"),
          reason: "user",
        },
        readModel: makeReadModel({}),
      });
      const awakeEvents = Array.isArray(awake) ? awake : [awake];
      expect(awakeEvents[0]?.type).toBe("thread.unsnoozed");
      if (awakeEvents[0]?.type === "thread.unsnoozed") {
        // No state change — keep the existing updatedAt.
        expect(awakeEvents[0].payload.updatedAt).toBe(NOW);
      }
    }),
  );

  it.effect("rejects snoozing a thread with a queued turn start", () =>
    Effect.gen(function* () {
      // The decider clock is the Effect test clock pinned to the epoch: a
      // user message 30s before it with no adopting turn is queued work.
      const queuedMessage = {
        id: MessageId.make("message-queued"),
        role: "user",
        text: "Continue",
        turnId: null,
        streaming: false,
        createdAt: "1969-12-31T23:59:30.000Z",
        updatedAt: "1969-12-31T23:59:30.000Z",
      } as OrchestrationThread["messages"][number];
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.snooze",
          commandId: CommandId.make("cmd-snooze-queued"),
          threadId: ThreadId.make("thread-1"),
          snoozedUntil: FUTURE_WAKE,
        },
        readModel: makeReadModel({ messages: [queuedMessage] }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects snoozing an archived thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.snooze",
          commandId: CommandId.make("cmd-snooze-archived"),
          threadId: ThreadId.make("thread-1"),
          snoozedUntil: FUTURE_WAKE,
        },
        readModel: makeReadModel({ archivedAt: NOW }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("a user message spends the snooze return ticket (activity wake)", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
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
        readModel: makeReadModel({ snoozedUntil: FUTURE_WAKE }),
      });
      const events = Array.isArray(result) ? result : [result];
      const unsnoozed = events.find((entry) => entry.type === "thread.unsnoozed");
      expect(unsnoozed).toBeDefined();
      if (unsnoozed?.type === "thread.unsnoozed") {
        expect(unsnoozed.payload.reason).toBe("activity");
      }
    }),
  );
});
