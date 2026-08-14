import {
  CommandId,
  MessageId,
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
const PARENT_THREAD_ID = ThreadId.make("thread-parent");
const CHILD_THREAD_ID = ThreadId.make("thread-child");
const PROJECT_ID = ProjectId.make("project-1");
const TURN_ID = TurnId.make("turn-1");

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: PARENT_THREAD_ID,
    projectId: PROJECT_ID,
    title: "Parent thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeReadModel(threads: ReadonlyArray<OrchestrationThread>): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads,
    updatedAt: NOW,
  };
}

function makeChildSession(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: CHILD_THREAD_ID,
    status,
    providerName: "Codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  };
}

function createChildCommand(parentThreadId: ThreadId | null) {
  return {
    type: "thread.create",
    commandId: CommandId.make("cmd-create-child"),
    threadId: CHILD_THREAD_ID,
    projectId: PROJECT_ID,
    title: "Fix the flaky tests",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    parentThreadId,
    createdAt: NOW,
  } as const;
}

it.layer(NodeServices.layer)("parallel agent decider", (it) => {
  it.effect("thread.create with a parent records the link and a spawn activity", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: createChildCommand(PARENT_THREAD_ID),
        readModel: makeReadModel([makeThread()]),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.activity-appended",
        "thread.created",
      ]);
      const [activityEvent, createdEvent] = events;
      if (createdEvent?.type === "thread.created") {
        expect(createdEvent.payload.parentThreadId).toBe(PARENT_THREAD_ID);
      }
      if (activityEvent?.type === "thread.activity-appended") {
        expect(activityEvent.aggregateId).toBe(PARENT_THREAD_ID);
        expect(activityEvent.payload.threadId).toBe(PARENT_THREAD_ID);
        expect(activityEvent.payload.activity.kind).toBe("parallel-agent.started");
        expect(activityEvent.payload.activity.payload).toMatchObject({
          childThreadId: CHILD_THREAD_ID,
          childTitle: "Fix the flaky tests",
        });
      }
    }),
  );

  it.effect("thread.create without a parent emits only thread.created", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: createChildCommand(null),
        readModel: makeReadModel([makeThread()]),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.created"]);
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.parentThreadId).toBe(null);
      }
    }),
  );

  it.effect("thread.create rejects a missing or cross-project parent", () =>
    Effect.gen(function* () {
      const missingParent = yield* decideOrchestrationCommand({
        command: createChildCommand(ThreadId.make("thread-nope")),
        readModel: makeReadModel([makeThread()]),
      }).pipe(Effect.flip);
      expect(missingParent._tag).toBe("OrchestrationCommandInvariantError");

      const otherProjectId = ProjectId.make("project-2");
      const baseReadModel = makeReadModel([makeThread({ projectId: otherProjectId })]);
      const crossProjectReadModel: OrchestrationReadModel = {
        ...baseReadModel,
        projects: [
          ...baseReadModel.projects,
          {
            ...baseReadModel.projects[0]!,
            id: otherProjectId,
            workspaceRoot: "/tmp/project-2",
          },
        ],
      };
      const crossProject = yield* decideOrchestrationCommand({
        command: createChildCommand(PARENT_THREAD_ID),
        readModel: crossProjectReadModel,
      }).pipe(Effect.flip);
      expect(crossProject._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("child turn end surfaces the result into the parent thread", () =>
    Effect.gen(function* () {
      const childThread = makeThread({
        id: CHILD_THREAD_ID,
        title: "Fix the flaky tests",
        parentThreadId: PARENT_THREAD_ID,
        latestTurn: {
          turnId: TURN_ID,
          state: "running",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: null,
          assistantMessageId: null,
        },
        messages: [
          {
            id: MessageId.make("message-1"),
            role: "assistant",
            text: "All tests pass now.",
            turnId: TURN_ID,
            streaming: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set"),
          threadId: CHILD_THREAD_ID,
          session: makeChildSession("idle"),
          createdAt: NOW,
        },
        readModel: makeReadModel([makeThread(), childThread]),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.activity-appended",
        "thread.session-set",
      ]);
      const [activityEvent] = events;
      if (activityEvent?.type === "thread.activity-appended") {
        expect(activityEvent.payload.threadId).toBe(PARENT_THREAD_ID);
        expect(activityEvent.payload.activity.kind).toBe("parallel-agent.completed");
        expect(activityEvent.payload.activity.tone).toBe("info");
        expect(activityEvent.payload.activity.payload).toMatchObject({
          childThreadId: CHILD_THREAD_ID,
          childTitle: "Fix the flaky tests",
          turnId: TURN_ID,
          state: "completed",
          detail: "All tests pass now.",
        });
      }
    }),
  );

  it.effect("a failed child turn surfaces as an error activity", () =>
    Effect.gen(function* () {
      const childThread = makeThread({
        id: CHILD_THREAD_ID,
        parentThreadId: PARENT_THREAD_ID,
        latestTurn: {
          turnId: TURN_ID,
          state: "running",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: null,
          assistantMessageId: null,
        },
      });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-error"),
          threadId: CHILD_THREAD_ID,
          session: makeChildSession("error"),
          createdAt: NOW,
        },
        readModel: makeReadModel([makeThread(), childThread]),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      const activityEvent = events.find((event) => event.type === "thread.activity-appended");
      expect(activityEvent).toBeDefined();
      if (activityEvent?.type === "thread.activity-appended") {
        expect(activityEvent.payload.activity.kind).toBe("parallel-agent.failed");
        expect(activityEvent.payload.activity.tone).toBe("error");
      }
    }),
  );

  it.effect("no parent activity when the turn already settled or there is no parent", () =>
    Effect.gen(function* () {
      // Already-settled turn: a later status write (ready -> stopped) must not
      // re-announce the same turn in the parent.
      const settledChild = makeThread({
        id: CHILD_THREAD_ID,
        parentThreadId: PARENT_THREAD_ID,
        latestTurn: {
          turnId: TURN_ID,
          state: "completed",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: null,
        },
      });
      const settledDecision = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-settled"),
          threadId: CHILD_THREAD_ID,
          session: makeChildSession("stopped"),
          createdAt: NOW,
        },
        readModel: makeReadModel([makeThread(), settledChild]),
      });
      const settledEvents = Array.isArray(settledDecision) ? settledDecision : [settledDecision];
      expect(settledEvents.map((event) => event.type)).toEqual(["thread.session-set"]);

      // Parent-less thread: plain session writes stay single-event.
      const orphanThread = makeThread({
        id: CHILD_THREAD_ID,
        parentThreadId: null,
        latestTurn: {
          turnId: TURN_ID,
          state: "running",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: null,
          assistantMessageId: null,
        },
      });
      const orphanDecision = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-orphan"),
          threadId: CHILD_THREAD_ID,
          session: makeChildSession("idle"),
          createdAt: NOW,
        },
        readModel: makeReadModel([orphanThread]),
      });
      const orphanEvents = Array.isArray(orphanDecision) ? orphanDecision : [orphanDecision];
      expect(orphanEvents.map((event) => event.type)).toEqual(["thread.session-set"]);
    }),
  );

  it.effect("backfills the parent activity once the buffered assistant text flushes", () =>
    Effect.gen(function* () {
      // Buffered delivery settles the session before the assistant text is
      // flushed, so the turn-end activity has no detail yet.
      const settlingChild = makeThread({
        id: CHILD_THREAD_ID,
        title: "Fix the flaky tests",
        parentThreadId: PARENT_THREAD_ID,
        latestTurn: {
          turnId: TURN_ID,
          state: "running",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: null,
          assistantMessageId: null,
        },
      });
      const settleDecision = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set"),
          threadId: CHILD_THREAD_ID,
          session: makeChildSession("idle"),
          createdAt: NOW,
        },
        readModel: makeReadModel([makeThread(), settlingChild]),
      });
      const settleEvents = Array.isArray(settleDecision) ? settleDecision : [settleDecision];
      const [initialActivityEvent] = settleEvents;
      if (initialActivityEvent?.type !== "thread.activity-appended") {
        throw new Error("expected a parent activity on settle");
      }
      expect(initialActivityEvent.payload.activity.payload).not.toHaveProperty("detail");
      const activityId = initialActivityEvent.payload.activity.id;

      // The settled child thread, as the read model looks once session.set
      // above has committed: turn is no longer "running".
      const settledChild = makeThread({
        id: CHILD_THREAD_ID,
        title: "Fix the flaky tests",
        parentThreadId: PARENT_THREAD_ID,
        latestTurn: {
          turnId: TURN_ID,
          state: "completed",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: null,
        },
      });
      const backfillDecision = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("cmd-assistant-delta-flush"),
          threadId: CHILD_THREAD_ID,
          messageId: MessageId.make("message-1"),
          delta: "All tests pass now.",
          turnId: TURN_ID,
          createdAt: NOW,
        },
        readModel: makeReadModel([makeThread(), settledChild]),
      });
      const backfillEvents = Array.isArray(backfillDecision)
        ? backfillDecision
        : [backfillDecision];
      expect(backfillEvents.map((event) => event.type)).toEqual([
        "thread.activity-appended",
        "thread.message-sent",
      ]);
      const [backfillActivityEvent] = backfillEvents;
      if (backfillActivityEvent?.type !== "thread.activity-appended") {
        throw new Error("expected a backfilled parent activity");
      }
      // Same id as the original: the projector replaces it in place.
      expect(backfillActivityEvent.payload.activity.id).toBe(activityId);
      expect(backfillActivityEvent.payload.activity.payload).toMatchObject({
        detail: "All tests pass now.",
      });
    }),
  );

  it.effect("does not backfill a mid-turn delta or a later, unrelated turn", () =>
    Effect.gen(function* () {
      // Mid-turn delta: the turn is still "running", not the late flush.
      const runningChild = makeThread({
        id: CHILD_THREAD_ID,
        parentThreadId: PARENT_THREAD_ID,
        latestTurn: {
          turnId: TURN_ID,
          state: "running",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: null,
          assistantMessageId: null,
        },
      });
      const midTurnDecision = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("cmd-mid-turn-delta"),
          threadId: CHILD_THREAD_ID,
          messageId: MessageId.make("message-1"),
          delta: "still working",
          turnId: TURN_ID,
          createdAt: NOW,
        },
        readModel: makeReadModel([makeThread(), runningChild]),
      });
      const midTurnEvents = Array.isArray(midTurnDecision) ? midTurnDecision : [midTurnDecision];
      expect(midTurnEvents.map((event) => event.type)).toEqual(["thread.message-sent"]);

      // A later, second turn settling must not re-notify the parent.
      const secondTurnId = TurnId.make("turn-2");
      const secondTurnChild = makeThread({
        id: CHILD_THREAD_ID,
        parentThreadId: PARENT_THREAD_ID,
        latestTurn: {
          turnId: secondTurnId,
          state: "completed",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: null,
        },
        messages: [
          {
            id: MessageId.make("message-1"),
            role: "assistant",
            text: "First result.",
            turnId: TURN_ID,
            streaming: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      });
      const secondTurnDecision = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("cmd-second-turn-delta"),
          threadId: CHILD_THREAD_ID,
          messageId: MessageId.make("message-2"),
          delta: "Unrelated follow-up answer.",
          turnId: secondTurnId,
          createdAt: NOW,
        },
        readModel: makeReadModel([makeThread(), secondTurnChild]),
      });
      const secondTurnEvents = Array.isArray(secondTurnDecision)
        ? secondTurnDecision
        : [secondTurnDecision];
      expect(secondTurnEvents.map((event) => event.type)).toEqual(["thread.message-sent"]);
    }),
  );

  it.effect(
    "surfaces a failed-to-start activity when the child never reaches 'running', and never a second turn",
    () =>
      Effect.gen(function* () {
        // The provider failed to connect at all: no turn was ever running.
        const neverStartedChild = makeThread({
          id: CHILD_THREAD_ID,
          title: "Fix the flaky tests",
          parentThreadId: PARENT_THREAD_ID,
          latestTurn: null,
          messages: [],
        });
        const decision = yield* decideOrchestrationCommand({
          command: {
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-set-never-started"),
            threadId: CHILD_THREAD_ID,
            session: makeChildSession("error"),
            createdAt: NOW,
          },
          readModel: makeReadModel([makeThread(), neverStartedChild]),
        });
        const events = Array.isArray(decision) ? decision : [decision];
        expect(events.map((event) => event.type)).toEqual([
          "thread.activity-appended",
          "thread.session-set",
        ]);
        const [activityEvent] = events;
        if (activityEvent?.type !== "thread.activity-appended") {
          throw new Error("expected a failed-to-start activity");
        }
        // Same id as the spawn activity, so it corrects that row in place.
        expect(activityEvent.payload.activity.id).toBe(`parallel-agent:started:${CHILD_THREAD_ID}`);
        expect(activityEvent.payload.activity.kind).toBe("parallel-agent.failed");

        // A second, later immediate-failure write for the same never-started
        // thread must not fire twice: once messages/turns exist the guard no
        // longer treats it as "never got going".
        const alreadyReportedChild = makeThread({
          id: CHILD_THREAD_ID,
          parentThreadId: PARENT_THREAD_ID,
          latestTurn: null,
          messages: [
            {
              id: MessageId.make("message-1"),
              role: "user",
              text: "retry",
              turnId: null,
              streaming: false,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        });
        const secondDecision = yield* decideOrchestrationCommand({
          command: {
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-set-never-started-2"),
            threadId: CHILD_THREAD_ID,
            session: makeChildSession("error"),
            createdAt: NOW,
          },
          readModel: makeReadModel([makeThread(), alreadyReportedChild]),
        });
        const secondEvents = Array.isArray(secondDecision) ? secondDecision : [secondDecision];
        expect(secondEvents.map((event) => event.type)).toEqual(["thread.session-set"]);
      }),
  );

  it.effect("truncates the result preview without splitting a surrogate pair", () =>
    Effect.gen(function* () {
      const settlingChild = makeThread({
        id: CHILD_THREAD_ID,
        parentThreadId: PARENT_THREAD_ID,
        latestTurn: {
          turnId: TURN_ID,
          state: "running",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: null,
        },
      });
      // An emoji (surrogate pair) straddling the 4,000-char cut point.
      const longText = `${"a".repeat(3_999)}😀${"b".repeat(10)}`;
      const decision = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-long-text"),
          threadId: CHILD_THREAD_ID,
          session: makeChildSession("idle"),
          createdAt: NOW,
        },
        readModel: makeReadModel([
          makeThread(),
          {
            ...settlingChild,
            messages: [
              {
                id: MessageId.make("message-1"),
                role: "assistant",
                text: longText,
                turnId: TURN_ID,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          },
        ]),
      });
      const events = Array.isArray(decision) ? decision : [decision];
      const [activityEvent] = events;
      if (activityEvent?.type !== "thread.activity-appended") {
        throw new Error("expected a parent activity");
      }
      const detail = (activityEvent.payload.activity.payload as { detail?: string }).detail;
      expect(detail).toBeDefined();
      // No lone surrogate at the end: the string round-trips through
      // Array.from without losing a paired code point.
      expect(Array.from(detail!).length).not.toBe(0);
      expect(detail!.endsWith("😀…")).toBe(true);
    }),
  );
});
