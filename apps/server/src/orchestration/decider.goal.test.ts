import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeReadModel(input: {
  readonly interactionMode?: OrchestrationThread["interactionMode"];
  readonly latestTurn?: OrchestrationThread["latestTurn"];
  readonly session?: OrchestrationThread["session"];
  readonly goal?: OrchestrationThread["goal"];
  readonly settledOverride?: OrchestrationThread["settledOverride"];
  readonly snoozedUntil?: string | null;
  readonly activities?: OrchestrationThread["activities"];
  readonly messages?: OrchestrationThread["messages"];
  readonly checkpoints?: OrchestrationThread["checkpoints"];
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
        interactionMode: input.interactionMode ?? "default",
        branch: null,
        worktreePath: null,
        latestTurn: input.latestTurn ?? null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: input.settledOverride ?? null,
        settledAt: null,
        snoozedUntil: input.snoozedUntil ?? null,
        snoozedAt: input.snoozedUntil != null ? NOW : null,
        deletedAt: null,
        messages: input.messages ?? [],
        proposedPlans: [],
        activities: input.activities ?? [],
        checkpoints: input.checkpoints ?? [],
        session: input.session ?? null,
        ...(input.goal !== undefined ? { goal: input.goal } : {}),
      },
    ],
    updatedAt: NOW,
  };
}

function runningTurn(): OrchestrationThread["latestTurn"] {
  return {
    turnId: TurnId.make("turn-running"),
    state: "running",
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: null,
    assistantMessageId: null,
  };
}

function existingGoal(): NonNullable<OrchestrationThread["goal"]> {
  return {
    objective: "Reduce p95 below 120ms",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function activeGoal(
  status: NonNullable<OrchestrationThread["goal"]>["status"] = "active",
): NonNullable<OrchestrationThread["goal"]> {
  return {
    ...existingGoal(),
    status,
  };
}

function completedTurn(turnId = "turn-1"): NonNullable<OrchestrationThread["latestTurn"]> {
  return {
    turnId: TurnId.make(turnId),
    state: "completed",
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    assistantMessageId: null,
  };
}

function readySession(): NonNullable<OrchestrationThread["session"]> {
  return {
    threadId: ThreadId.make("thread-1"),
    status: "ready",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  };
}

function runningSession(): NonNullable<OrchestrationThread["session"]> {
  return {
    threadId: ThreadId.make("thread-1"),
    status: "running",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: TurnId.make("turn-running"),
    lastError: null,
    updatedAt: NOW,
  };
}

function continuedActivity(): OrchestrationThread["activities"][number] {
  return {
    id: EventId.make("activity-continued"),
    tone: "info",
    kind: "goal.continued",
    summary: "Reduce p95 below 120ms",
    payload: {},
    turnId: null,
    createdAt: NOW,
  };
}

it.layer(NodeServices.layer)("Goal decider", (it) => {
  it.effect(
    "sets a Goal on an idle Thread, records the Objective as a user message, and starts a Turn",
    () =>
      Effect.gen(function* () {
        const decided = yield* decideOrchestrationCommand({
          command: {
            type: "thread.goal.set",
            commandId: CommandId.make("cmd-goal-set"),
            threadId: ThreadId.make("thread-1"),
            objective: "Reduce p95 below 120ms",
            messageId: MessageId.make("message-goal-1"),
          },
          readModel: makeReadModel({}),
        });
        const events = Array.isArray(decided) ? decided : [decided];
        expect(events.map((event) => event.type)).toEqual([
          "thread.goal-set",
          "thread.activity-appended",
          "thread.message-sent",
          "thread.turn-start-requested",
        ]);
        const goalSet = events[0];
        if (goalSet?.type !== "thread.goal-set") {
          throw new Error("Expected thread.goal-set.");
        }
        expect(goalSet.payload.objective).toBe("Reduce p95 below 120ms");
        expect(goalSet.payload.status).toBe("active");
        const activity = events[1];
        if (activity?.type !== "thread.activity-appended") {
          throw new Error("Expected thread.activity-appended.");
        }
        expect(activity.payload.activity.kind).toBe("goal.set");
        expect(activity.payload.activity.tone).toBe("info");
        expect(activity.payload.activity.summary).toBe("Reduce p95 below 120ms");
        const messageSent = events[2];
        if (messageSent?.type !== "thread.message-sent") {
          throw new Error("Expected thread.message-sent.");
        }
        expect(messageSent.payload.text).toBe("Reduce p95 below 120ms");
        expect(messageSent.payload.messageId).toBe("message-goal-1");
        const turnStart = events[3];
        if (turnStart?.type !== "thread.turn-start-requested") {
          throw new Error("Expected thread.turn-start-requested.");
        }
        expect(turnStart.payload.messageId).toBe("message-goal-1");
        expect(turnStart.payload.interactionMode).toBe("default");
        expect(turnStart.payload.titleSeed).toBe("Reduce p95 below 120ms");
      }),
  );

  it.effect("sets interaction mode to default when becoming Active in plan mode", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.make("cmd-goal-set-plan"),
          threadId: ThreadId.make("thread-1"),
          objective: "Implement this plan",
          messageId: MessageId.make("message-goal-plan"),
        },
        readModel: makeReadModel({ interactionMode: "plan" }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toContain("thread.interaction-mode-set");
      const modeSet = events.find((event) => event.type === "thread.interaction-mode-set");
      if (modeSet?.type !== "thread.interaction-mode-set") {
        throw new Error("Expected thread.interaction-mode-set.");
      }
      expect(modeSet.payload.interactionMode).toBe("default");
    }),
  );

  it.effect(
    "attaches or replaces a Goal while a Turn is running without starting a second Turn",
    () =>
      Effect.gen(function* () {
        const decided = yield* decideOrchestrationCommand({
          command: {
            type: "thread.goal.set",
            commandId: CommandId.make("cmd-goal-attach"),
            threadId: ThreadId.make("thread-1"),
            objective: "Ship the migration instead",
          },
          readModel: makeReadModel({
            latestTurn: runningTurn(),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.make("turn-running"),
              lastError: null,
              updatedAt: NOW,
            },
            goal: existingGoal(),
          }),
        });
        const events = Array.isArray(decided) ? decided : [decided];
        expect(events.map((event) => event.type)).not.toContain("thread.turn-start-requested");
        expect(events.map((event) => event.type)).not.toContain("thread.message-sent");
        const goalSet = events.find((event) => event.type === "thread.goal-set");
        if (goalSet?.type !== "thread.goal-set") {
          throw new Error("Expected thread.goal-set.");
        }
        expect(goalSet.payload.objective).toBe("Ship the migration instead");
        expect(goalSet.payload.createdAt).toBe(NOW);
      }),
  );

  it.effect("attaches a Goal while the session is starting without starting a second Turn", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.make("cmd-goal-starting"),
          threadId: ThreadId.make("thread-1"),
          objective: "Ship the migration instead",
        },
        readModel: makeReadModel({
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "starting",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.goal-set",
        "thread.activity-appended",
      ]);
    }),
  );

  it.effect("replaces the current Goal so a Thread never has two", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.make("cmd-goal-replace"),
          threadId: ThreadId.make("thread-1"),
          objective: "the goal of this function is X",
          messageId: MessageId.make("message-replace"),
        },
        readModel: makeReadModel({
          goal: {
            objective: "Reduce p95 below 120ms",
            status: "paused",
            createdAt: NOW,
            updatedAt: NOW,
          },
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      const goalSets = events.filter((event) => event.type === "thread.goal-set");
      expect(goalSets).toHaveLength(1);
      if (goalSets[0]?.type === "thread.goal-set") {
        expect(goalSets[0].payload.objective).toBe("the goal of this function is X");
        expect(goalSets[0].payload.status).toBe("active");
        expect(goalSets[0].payload.createdAt).toBe(NOW);
      }
    }),
  );

  it.effect("clears the Goal", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.clear",
          commandId: CommandId.make("cmd-goal-clear"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({
          goal: existingGoal(),
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.goal-cleared",
        "thread.activity-appended",
      ]);
      const activity = events[1];
      if (activity?.type !== "thread.activity-appended") {
        throw new Error("Expected thread.activity-appended.");
      }
      expect(activity.payload.activity.kind).toBe("goal.cleared");
      expect(activity.payload.activity.summary).toBe("Objective cleared");
      expect(events.map((event) => event.type)).not.toContain("thread.turn-start-requested");
    }),
  );

  it.effect("clears the Goal and interrupts a running Turn", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.clear",
          commandId: CommandId.make("cmd-goal-clear-running"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({
          goal: existingGoal(),
          latestTurn: runningTurn(),
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.turn-interrupt-requested",
        "thread.goal-cleared",
        "thread.activity-appended",
      ]);
    }),
  );

  it.effect("does not interrupt a running Turn when clearing an already-removed Goal", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.clear",
          commandId: CommandId.make("cmd-goal-clear-stale"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({
          latestTurn: runningTurn(),
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.goal-cleared"]);
    }),
  );

  it.effect("pauses an existing Goal without interrupting the Turn", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.pause",
          commandId: CommandId.make("cmd-goal-pause"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({
          latestTurn: runningTurn(),
          goal: existingGoal(),
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.goal-paused",
        "thread.activity-appended",
      ]);
      expect(events.map((event) => event.type)).not.toContain("thread.turn-interrupt-requested");
    }),
  );

  it.effect("resumes a Paused Goal on an idle Thread by starting a Continuation immediately", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.resume",
          commandId: CommandId.make("cmd-goal-resume"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({
          interactionMode: "plan",
          goal: {
            ...existingGoal(),
            status: "paused",
          },
          latestTurn: completedTurn(),
          session: readySession(),
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.goal-resumed",
        "thread.interaction-mode-set",
        "thread.activity-appended",
        "thread.activity-appended",
        "thread.turn-start-requested",
      ]);
      const kinds = events
        .filter((event) => event.type === "thread.activity-appended")
        .map((event) => event.payload.activity.kind);
      expect(kinds).toEqual(["goal.resumed", "goal.continued"]);
      const turnStart = events.find((event) => event.type === "thread.turn-start-requested");
      if (turnStart?.type !== "thread.turn-start-requested") {
        throw new Error("Expected thread.turn-start-requested.");
      }
      expect(turnStart.payload.messageId).toBeUndefined();
      expect(turnStart.payload.interactionMode).toBe("default");
    }),
  );

  it.effect("resumes while a Turn is running as status-only without starting a second Turn", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.resume",
          commandId: CommandId.make("cmd-goal-resume-running"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({
          interactionMode: "plan",
          latestTurn: runningTurn(),
          session: runningSession(),
          goal: {
            ...existingGoal(),
            status: "paused",
          },
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.goal-resumed",
        "thread.interaction-mode-set",
        "thread.activity-appended",
      ]);
      expect(events.map((event) => event.type)).not.toContain("thread.turn-start-requested");
    }),
  );

  it.effect("refuses an Objective that is itself a command form", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.make("cmd-goal-form-objective"),
          threadId: ThreadId.make("thread-1"),
          objective: "/goal Reduce p95 below 120ms",
        },
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("refuses thread.turn.start whose user text is a command form", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-goal-form"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-1"),
            role: "user",
            text: "/goal Reduce p95 below 120ms",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("refuses a leading slash goal spoken command form", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-slash-goal"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-2"),
            role: "user",
            text: "slash goal Reduce p95 below 120ms",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("accepts a user message that contains the English word goal", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-english-goal"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-3"),
            role: "user",
            text: "the goal of this function is X",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toContain("thread.message-sent");
      expect(events.map((event) => event.type)).not.toContain("thread.goal-set");
    }),
  );

  it.effect("continues an Active Goal with no user message after a completed Turn", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.continue",
          commandId: CommandId.make("cmd-goal-continue"),
          threadId: ThreadId.make("thread-1"),
          completedTurnId: TurnId.make("turn-1"),
        },
        readModel: makeReadModel({
          goal: activeGoal(),
          latestTurn: completedTurn(),
          session: readySession(),
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.activity-appended",
        "thread.turn-start-requested",
      ]);
      expect(events.map((event) => event.type)).not.toContain("thread.message-sent");
      const activity = events[0];
      if (activity?.type !== "thread.activity-appended") {
        throw new Error("Expected thread.activity-appended.");
      }
      expect(activity.payload.activity.kind).toBe("goal.continued");
      expect(activity.payload.activity.tone).toBe("info");
      expect(activity.payload.activity.summary).toBe("Reduce p95 below 120ms");
      const turnStart = events[1];
      if (turnStart?.type !== "thread.turn-start-requested") {
        throw new Error("Expected thread.turn-start-requested.");
      }
      expect(turnStart.payload.messageId).toBeUndefined();
      expect(turnStart.payload.interactionMode).toBe("default");
    }),
  );

  it.effect("does not continue when the Goal is paused", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.continue",
          commandId: CommandId.make("cmd-goal-continue-paused"),
          threadId: ThreadId.make("thread-1"),
          completedTurnId: TurnId.make("turn-1"),
        },
        readModel: makeReadModel({
          goal: activeGoal("paused"),
          latestTurn: completedTurn(),
          session: readySession(),
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("does not continue in plan mode", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.continue",
          commandId: CommandId.make("cmd-goal-continue-plan"),
          threadId: ThreadId.make("thread-1"),
          completedTurnId: TurnId.make("turn-1"),
        },
        readModel: makeReadModel({
          interactionMode: "plan",
          goal: activeGoal(),
          latestTurn: completedTurn(),
          session: readySession(),
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("does not continue while a pending approval is open", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.continue",
          commandId: CommandId.make("cmd-goal-continue-approval"),
          threadId: ThreadId.make("thread-1"),
          completedTurnId: TurnId.make("turn-1"),
        },
        readModel: makeReadModel({
          goal: activeGoal(),
          latestTurn: completedTurn(),
          session: readySession(),
          activities: [
            {
              id: EventId.make("activity-approval"),
              tone: "approval",
              kind: "approval.requested",
              summary: "approval.requested",
              payload: { requestId: "req-1" },
              turnId: null,
              createdAt: NOW,
            },
          ],
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("does not start a second Continuation for the same completed Turn", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.continue",
          commandId: CommandId.make("cmd-goal-continue-again"),
          threadId: ThreadId.make("thread-1"),
          completedTurnId: TurnId.make("turn-1"),
        },
        readModel: makeReadModel({
          goal: activeGoal(),
          latestTurn: completedTurn(),
          session: readySession(),
          activities: [continuedActivity()],
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("Stop interrupts the Turn and Pauses an Active Goal", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.interrupt",
          commandId: CommandId.make("cmd-interrupt-goal"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
        },
        readModel: makeReadModel({
          latestTurn: runningTurn(),
          session: runningSession(),
          goal: existingGoal(),
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.turn-interrupt-requested",
        "thread.goal-paused",
        "thread.activity-appended",
      ]);
      const activity = events[2];
      if (activity?.type !== "thread.activity-appended") {
        throw new Error("Expected thread.activity-appended.");
      }
      expect(activity.payload.activity.kind).toBe("goal.paused");
    }),
  );

  it.effect("Stop without an Active Goal only interrupts the Turn", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.interrupt",
          commandId: CommandId.make("cmd-interrupt-no-goal"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
        },
        readModel: makeReadModel({
          latestTurn: runningTurn(),
          session: runningSession(),
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.turn-interrupt-requested"]);
    }),
  );

  it.effect("Stop targeting the running Turn Pauses the Goal", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.interrupt",
          commandId: CommandId.make("cmd-interrupt-running-turn"),
          threadId: ThreadId.make("thread-1"),
          turnId: TurnId.make("turn-running"),
          createdAt: NOW,
        },
        readModel: makeReadModel({
          latestTurn: runningTurn(),
          session: runningSession(),
          goal: existingGoal(),
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.turn-interrupt-requested",
        "thread.goal-paused",
        "thread.activity-appended",
      ]);
    }),
  );

  it.effect("a delayed Stop for a finished Turn does not Pause the Goal", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.interrupt",
          commandId: CommandId.make("cmd-interrupt-stale-turn"),
          threadId: ThreadId.make("thread-1"),
          turnId: TurnId.make("turn-1"),
          createdAt: NOW,
        },
        readModel: makeReadModel({
          latestTurn: completedTurn("turn-1"),
          session: readySession(),
          goal: existingGoal(),
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.turn-interrupt-requested"]);
    }),
  );

  it.effect("resume does not double-start after a Continuation was already requested", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.resume",
          commandId: CommandId.make("cmd-goal-resume-idempotent"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({
          goal: activeGoal("paused"),
          latestTurn: completedTurn(),
          session: readySession(),
          activities: [continuedActivity()],
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.goal-resumed",
        "thread.activity-appended",
      ]);
      expect(events.map((event) => event.type)).not.toContain("thread.turn-start-requested");
    }),
  );

  it.effect("Settle does not Pause an Active Goal", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-goal"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({
          goal: activeGoal(),
          latestTurn: completedTurn(),
          session: readySession(),
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toContain("thread.settled");
      expect(events.map((event) => event.type)).not.toContain("thread.goal-paused");
    }),
  );

  it.effect("Snooze does not Pause an Active Goal", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.snooze",
          commandId: CommandId.make("cmd-snooze-goal"),
          threadId: ThreadId.make("thread-1"),
          snoozedUntil: "2099-01-01T00:00:00.000Z",
        },
        readModel: makeReadModel({
          goal: activeGoal(),
          latestTurn: completedTurn(),
          session: readySession(),
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.snoozed"]);
      expect(events.map((event) => event.type)).not.toContain("thread.goal-paused");
    }),
  );

  it.effect("structured Complete tag Completes an Active Goal", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("cmd-assistant-complete-tag"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("assistant-1"),
          createdAt: NOW,
        },
        readModel: makeReadModel({
          goal: activeGoal(),
          latestTurn: completedTurn(),
          session: readySession(),
          messages: [
            {
              id: MessageId.make("assistant-1"),
              role: "assistant",
              text: "<objective_complete>p95 is 90ms</objective_complete>",
              turnId: TurnId.make("turn-1"),
              streaming: false,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.goal-completed",
        "thread.activity-appended",
      ]);
    }),
  );

  it.effect("structured Blocked tag Blocks an Active Goal", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("cmd-assistant-blocked-tag"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("assistant-1"),
          createdAt: NOW,
        },
        readModel: makeReadModel({
          goal: activeGoal(),
          latestTurn: completedTurn(),
          session: readySession(),
          messages: [
            {
              id: MessageId.make("assistant-1"),
              role: "assistant",
              text: "<objective_blocked>tests fail in CI</objective_blocked>",
              turnId: TurnId.make("turn-1"),
              streaming: false,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.goal-blocked",
        "thread.activity-appended",
      ]);
    }),
  );

  it.effect("assistant prose does not Complete or Block", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("cmd-assistant-prose"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("assistant-1"),
          createdAt: NOW,
        },
        readModel: makeReadModel({
          goal: activeGoal(),
          latestTurn: completedTurn(),
          session: readySession(),
          messages: [
            {
              id: MessageId.make("assistant-1"),
              role: "assistant",
              text: "we're done. I'm stuck.",
              turnId: TurnId.make("turn-1"),
              streaming: false,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.message-sent"]);
    }),
  );

  it.effect(
    "a signal from a Turn that predates a Goal replacement does not finalize the new Goal",
    () =>
      Effect.gen(function* () {
        const decided = yield* decideOrchestrationCommand({
          command: {
            type: "thread.message.assistant.complete",
            commandId: CommandId.make("cmd-assistant-stale-signal"),
            threadId: ThreadId.make("thread-1"),
            messageId: MessageId.make("assistant-1"),
            createdAt: NOW,
          },
          readModel: makeReadModel({
            goal: activeGoal(),
            latestTurn: completedTurn(),
            session: readySession(),
            activities: [
              {
                id: EventId.make("activity-goal-replaced"),
                tone: "info",
                kind: "goal.set",
                summary: "Ship the migration instead",
                payload: {},
                turnId: null,
                // The Goal was replaced after the completing Turn's message was
                // already streaming, so its signal belongs to the old Objective.
                createdAt: "2026-01-01T01:00:00.000Z",
              },
            ],
            messages: [
              {
                id: MessageId.make("assistant-1"),
                role: "assistant",
                text: "<objective_complete>p95 is 90ms</objective_complete>",
                turnId: TurnId.make("turn-1"),
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        });
        const events = Array.isArray(decided) ? decided : [decided];
        expect(events.map((event) => event.type)).toEqual(["thread.message-sent"]);
      }),
  );

  it.effect("a signal from a Turn started after the Goal was set still applies", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("cmd-assistant-fresh-signal"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("assistant-1"),
          createdAt: NOW,
        },
        readModel: makeReadModel({
          goal: activeGoal(),
          latestTurn: completedTurn(),
          session: readySession(),
          activities: [
            {
              id: EventId.make("activity-goal-set"),
              tone: "info",
              kind: "goal.set",
              summary: "Reduce p95 below 120ms",
              payload: {},
              turnId: null,
              createdAt: "2025-12-31T23:00:00.000Z",
            },
          ],
          messages: [
            {
              id: MessageId.make("assistant-1"),
              role: "assistant",
              text: "<objective_complete>p95 is 90ms</objective_complete>",
              turnId: TurnId.make("turn-1"),
              streaming: false,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.goal-completed",
        "thread.activity-appended",
      ]);
    }),
  );

  it.effect("blocks an Active Goal after empty Continuations", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.block",
          commandId: CommandId.make("cmd-goal-block"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({
          goal: activeGoal(),
          latestTurn: completedTurn(),
          session: readySession(),
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.goal-blocked",
        "thread.activity-appended",
      ]);
      expect(events.map((event) => event.type)).not.toContain("thread.goal-paused");
    }),
  );

  it.effect("resumes a Blocked Goal on an idle Thread by starting a Continuation", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.resume",
          commandId: CommandId.make("cmd-goal-resume-blocked"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({
          goal: activeGoal("blocked"),
          latestTurn: completedTurn(),
          session: readySession(),
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.goal-resumed",
        "thread.activity-appended",
        "thread.activity-appended",
        "thread.turn-start-requested",
      ]);
      const kinds = events
        .filter((event) => event.type === "thread.activity-appended")
        .map((event) => event.payload.activity.kind);
      expect(kinds).toEqual(["goal.resumed", "goal.continued"]);
    }),
  );

  it.effect("refuses to pause a Complete Goal", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.pause",
          commandId: CommandId.make("cmd-goal-pause-complete"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({
          goal: activeGoal("complete"),
          latestTurn: completedTurn(),
          session: readySession(),
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("attaches a Goal while an approval is open without starting the Turn", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.make("cmd-goal-set-open-approval"),
          threadId: ThreadId.make("thread-1"),
          objective: "Reduce p95 below 120ms",
        },
        readModel: makeReadModel({
          latestTurn: completedTurn(),
          session: readySession(),
          activities: [
            {
              id: EventId.make("activity-approval-open"),
              tone: "approval",
              kind: "approval.requested",
              summary: "approval.requested",
              payload: { requestId: "req-open" },
              turnId: null,
              createdAt: NOW,
            },
          ],
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.goal-set",
        "thread.activity-appended",
      ]);
    }),
  );

  it.effect("refuses to resume a Complete Goal", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.resume",
          commandId: CommandId.make("cmd-goal-resume-complete"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({
          goal: activeGoal("complete"),
          latestTurn: completedTurn(),
          session: readySession(),
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("quota or rate-limit Turn errors set an Active Goal to Usage-limited", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-rate-limit"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "error",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: "HTTP 429 Too Many Requests",
            updatedAt: NOW,
          },
        },
        readModel: makeReadModel({
          goal: activeGoal(),
          latestTurn: completedTurn(),
          session: runningSession(),
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.session-set",
        "thread.goal-usage-limited",
        "thread.activity-appended",
      ]);
      expect(events.map((event) => event.type)).not.toContain("thread.goal-blocked");
      expect(events.map((event) => event.type)).not.toContain("thread.goal-paused");
    }),
  );

  it.effect("ordinary Turn errors do not Usage-limit, Pause, or Block a Goal", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-ordinary-error"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "error",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: "turn failed",
            updatedAt: NOW,
          },
        },
        readModel: makeReadModel({
          goal: activeGoal(),
          latestTurn: completedTurn(),
          session: runningSession(),
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
    }),
  );

  it.effect("resumes a Usage-limited Goal on an idle Thread by starting a Continuation", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.resume",
          commandId: CommandId.make("cmd-goal-resume-usage-limited"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({
          goal: activeGoal("usageLimited"),
          latestTurn: completedTurn(),
          session: readySession(),
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.goal-resumed",
        "thread.activity-appended",
        "thread.activity-appended",
        "thread.turn-start-requested",
      ]);
    }),
  );
});
