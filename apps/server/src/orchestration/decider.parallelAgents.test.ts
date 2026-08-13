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
});
