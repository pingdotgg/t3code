// @effect-diagnostics globalDate:off globalTimers:off
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { goalBlockCommandId, goalContinuationCommandId } from "@t3tools/shared/goalContinuation";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, vi } from "vite-plus/test";

import * as GoalReactor from "./GoalReactor.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./Services/ProjectionSnapshotQuery.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const TURN_ID = TurnId.make("turn-1");

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeThread(input: {
  readonly id?: ThreadId;
  readonly goal?: OrchestrationThread["goal"];
  readonly interactionMode?: OrchestrationThread["interactionMode"];
  readonly latestTurn?: OrchestrationThread["latestTurn"];
  readonly session?: OrchestrationThread["session"];
  readonly activities?: OrchestrationThread["activities"];
}): OrchestrationThread {
  return {
    id: input.id ?? THREAD_ID,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: input.interactionMode ?? "default",
    branch: null,
    worktreePath: null,
    latestTurn:
      input.latestTurn ??
      ({
        turnId: TURN_ID,
        state: "completed",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: null,
      } satisfies NonNullable<OrchestrationThread["latestTurn"]>),
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: input.activities ?? [],
    checkpoints: [],
    session:
      input.session ??
      ({
        threadId: input.id ?? THREAD_ID,
        status: "ready",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: NOW,
      } satisfies NonNullable<OrchestrationThread["session"]>),
    ...(input.goal !== undefined ? { goal: input.goal } : {}),
  };
}

function activeGoal(
  status: NonNullable<OrchestrationThread["goal"]>["status"] = "active",
): NonNullable<OrchestrationThread["goal"]> {
  return {
    objective: "Reduce p95 below 120ms",
    status,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function sessionSetEvent(input: {
  readonly threadId?: ThreadId;
  readonly status: NonNullable<OrchestrationThread["session"]>["status"];
  readonly sequence?: number;
  readonly occurredAt?: string;
}): OrchestrationEvent {
  const threadId = input.threadId ?? THREAD_ID;
  const occurredAt = input.occurredAt ?? NOW;
  return {
    sequence: input.sequence ?? 1,
    eventId: EventId.make(`event-session-set-${input.sequence ?? 1}`),
    type: "thread.session-set",
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt,
    commandId: CommandId.make(`cmd-session-set-${input.sequence ?? 1}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      session: {
        threadId,
        status: input.status,
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: input.status === "running" ? TURN_ID : null,
        lastError: null,
        updatedAt: NOW,
      },
    },
  };
}

function toShell(
  thread: OrchestrationThread,
): OrchestrationThreadShell & { readonly goal: OrchestrationThreadShell["goal"] } {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurn: thread.latestTurn,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt,
    goal: thread.goal
      ? { status: thread.goal.status, objectivePreview: thread.goal.objective }
      : null,
    session: thread.session,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function runningSession(threadId: ThreadId): NonNullable<OrchestrationThread["session"]> {
  return {
    threadId,
    status: "running",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: TURN_ID,
    lastError: null,
    updatedAt: NOW,
  };
}

const createHarness = (threads: ReadonlyArray<OrchestrationThread>) =>
  Effect.gen(function* () {
    const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
    const dispatch = vi.fn(() => Effect.succeed({ sequence: 1 }));
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const getThreadDetailById = vi.fn((threadId: ThreadId) =>
      Effect.succeed(Option.fromNullishOr(threadsById.get(threadId))),
    );

    const engine = {
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.fromQueue(events),
      latestSequence: Effect.succeed(0),
    } satisfies OrchestrationEngineShape;

    const snapshotQuery = {
      getThreadDetailById,
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: [],
          threads: threads.map(toShell),
          updatedAt: NOW,
        }),
    } as unknown as ProjectionSnapshotQueryShape;

    const context = yield* Layer.build(
      GoalReactor.layer.pipe(
        Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
        Layer.provide(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
      ),
    );
    const reactor = Context.get(context, GoalReactor.GoalReactor);
    yield* reactor.start();

    return {
      dispatch,
      getThreadDetailById,
      // Mirrors the projection applying an event before the reactor sees it:
      // update the detail read first, then offer the event.
      setThread: (thread: OrchestrationThread) => {
        threadsById.set(thread.id, thread);
      },
      offer: (event: OrchestrationEvent) => Queue.offer(events, event),
      drain: reactor.drain,
    };
  });

describe("GoalReactor", () => {
  it.live("requests a Continuation when an Active Goal's Session becomes ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Session running at boot so the startup sweep skips the thread; the
        // ready event below is what must trigger the Continuation.
        const harness = yield* createHarness([
          makeThread({ goal: activeGoal(), session: runningSession(THREAD_ID) }),
        ]);
        harness.setThread(makeThread({ goal: activeGoal() }));
        yield* harness.offer(sessionSetEvent({ status: "ready" }));
        yield* Effect.promise(() => waitFor(() => harness.dispatch.mock.calls.length === 1));
        yield* harness.drain;

        expect(harness.dispatch).toHaveBeenCalledWith({
          type: "thread.goal.continue",
          commandId: CommandId.make(
            goalContinuationCommandId({
              threadId: THREAD_ID,
              goalUpdatedAt: NOW,
              completedTurnId: TURN_ID,
            }),
          ),
          threadId: THREAD_ID,
          completedTurnId: TURN_ID,
        });
      }),
    ),
  );

  it.live("does not request a Continuation when the Goal is paused", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* createHarness([makeThread({ goal: activeGoal("paused") })]);
        yield* harness.offer(sessionSetEvent({ status: "ready" }));
        yield* Effect.promise(() =>
          waitFor(() => harness.getThreadDetailById.mock.calls.length === 1),
        );
        yield* harness.drain;
        expect(harness.dispatch).not.toHaveBeenCalled();
      }),
    ),
  );

  it.live("does not request a Continuation when the Goal is Usage-limited", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* createHarness([makeThread({ goal: activeGoal("usageLimited") })]);
        yield* harness.offer(sessionSetEvent({ status: "ready" }));
        yield* Effect.promise(() =>
          waitFor(() => harness.getThreadDetailById.mock.calls.length === 1),
        );
        yield* harness.drain;
        expect(harness.dispatch).not.toHaveBeenCalled();
      }),
    ),
  );

  it.live("does not request a Continuation in plan mode", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* createHarness([
          makeThread({ goal: activeGoal(), interactionMode: "plan" }),
        ]);
        yield* harness.offer(sessionSetEvent({ status: "ready" }));
        yield* Effect.promise(() =>
          waitFor(() => harness.getThreadDetailById.mock.calls.length === 1),
        );
        yield* harness.drain;
        expect(harness.dispatch).not.toHaveBeenCalled();
      }),
    ),
  );

  it.live("does not request a Continuation while a pending approval is open", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* createHarness([
          makeThread({
            goal: activeGoal(),
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
        ]);
        yield* harness.offer(sessionSetEvent({ status: "ready" }));
        yield* Effect.promise(() =>
          waitFor(() => harness.getThreadDetailById.mock.calls.length === 1),
        );
        yield* harness.drain;
        expect(harness.dispatch).not.toHaveBeenCalled();
      }),
    ),
  );

  it.live("does not request a Continuation for a non-ready Session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const readyThreadId = ThreadId.make("thread-ready");
        const harness = yield* createHarness([
          makeThread({ goal: activeGoal(), session: runningSession(THREAD_ID) }),
          makeThread({
            id: readyThreadId,
            goal: activeGoal(),
            session: runningSession(readyThreadId),
          }),
        ]);
        harness.setThread(makeThread({ id: readyThreadId, goal: activeGoal() }));
        yield* harness.offer(sessionSetEvent({ status: "running", sequence: 1 }));
        yield* harness.offer(
          sessionSetEvent({ threadId: readyThreadId, status: "ready", sequence: 2 }),
        );
        yield* Effect.promise(() => waitFor(() => harness.dispatch.mock.calls.length === 1));
        yield* harness.drain;
        expect(harness.dispatch).toHaveBeenCalledTimes(1);
        expect(harness.dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "thread.goal.continue",
            threadId: readyThreadId,
          }),
        );
      }),
    ),
  );

  it.live("uses a stable command id for duplicate Session-ready events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* createHarness([
          makeThread({ goal: activeGoal(), session: runningSession(THREAD_ID) }),
        ]);
        harness.setThread(makeThread({ goal: activeGoal() }));
        yield* harness.offer(sessionSetEvent({ status: "ready", sequence: 1 }));
        yield* harness.offer(sessionSetEvent({ status: "ready", sequence: 2 }));
        yield* Effect.promise(() => waitFor(() => harness.dispatch.mock.calls.length === 2));
        yield* harness.drain;

        const commandId = CommandId.make(
          goalContinuationCommandId({
            threadId: THREAD_ID,
            goalUpdatedAt: NOW,
            completedTurnId: TURN_ID,
          }),
        );
        expect(harness.dispatch).toHaveBeenNthCalledWith(1, expect.objectContaining({ commandId }));
        expect(harness.dispatch).toHaveBeenNthCalledWith(2, expect.objectContaining({ commandId }));
      }),
    ),
  );

  it.live("Blocks after three empty Continuations instead of starting another", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const emptyContinuationActivities: OrchestrationThread["activities"] = [
          {
            id: EventId.make("activity-set"),
            tone: "info",
            kind: "goal.set",
            summary: "Reduce p95 below 120ms",
            payload: {},
            turnId: null,
            createdAt: NOW,
          },
          {
            id: EventId.make("activity-continued-1"),
            tone: "info",
            kind: "goal.continued",
            summary: "Reduce p95 below 120ms",
            payload: {},
            turnId: null,
            createdAt: "2026-01-01T00:01:00.000Z",
          },
          {
            id: EventId.make("activity-continued-2"),
            tone: "info",
            kind: "goal.continued",
            summary: "Reduce p95 below 120ms",
            payload: {},
            turnId: null,
            createdAt: "2026-01-01T00:02:00.000Z",
          },
          {
            id: EventId.make("activity-continued-3"),
            tone: "info",
            kind: "goal.continued",
            summary: "Reduce p95 below 120ms",
            payload: {},
            turnId: null,
            createdAt: "2026-01-01T00:03:00.000Z",
          },
        ];
        const harness = yield* createHarness([
          makeThread({
            goal: activeGoal(),
            session: runningSession(THREAD_ID),
            activities: emptyContinuationActivities,
          }),
        ]);
        harness.setThread(
          makeThread({ goal: activeGoal(), activities: emptyContinuationActivities }),
        );
        yield* harness.offer(
          sessionSetEvent({ status: "ready", occurredAt: "2026-01-01T00:04:00.000Z" }),
        );
        yield* Effect.promise(() => waitFor(() => harness.dispatch.mock.calls.length === 1));
        yield* harness.drain;
        expect(harness.dispatch).toHaveBeenCalledWith({
          type: "thread.goal.block",
          commandId: CommandId.make(
            goalBlockCommandId({
              threadId: THREAD_ID,
              goalUpdatedAt: NOW,
              completedTurnId: TURN_ID,
            }),
          ),
          threadId: THREAD_ID,
        });
      }),
    ),
  );

  it.live("settles a Turn orphaned by restart and resumes the active Goal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* createHarness([
          makeThread({
            goal: activeGoal(),
            latestTurn: {
              turnId: TURN_ID,
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              threadId: THREAD_ID,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TURN_ID,
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ]);
        yield* Effect.promise(() => waitFor(() => harness.dispatch.mock.calls.length === 2));

        expect(harness.dispatch).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            type: "thread.session.set",
            commandId: CommandId.make(`goal-restart-settle:${THREAD_ID}:${TURN_ID}`),
            threadId: THREAD_ID,
            session: expect.objectContaining({
              status: "interrupted",
              activeTurnId: null,
            }),
          }),
        );
        expect(harness.dispatch).toHaveBeenNthCalledWith(2, {
          type: "thread.goal.continue",
          commandId: CommandId.make(
            goalContinuationCommandId({
              threadId: THREAD_ID,
              goalUpdatedAt: NOW,
              completedTurnId: TURN_ID,
            }),
          ),
          threadId: THREAD_ID,
          completedTurnId: TURN_ID,
        });
      }),
    ),
  );

  it.live("resumes an idle Active Goal at startup when its Continuation trigger was missed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* createHarness([makeThread({ goal: activeGoal() })]);
        yield* Effect.promise(() => waitFor(() => harness.dispatch.mock.calls.length === 1));

        expect(harness.dispatch).toHaveBeenCalledWith({
          type: "thread.goal.continue",
          commandId: CommandId.make(
            goalContinuationCommandId({
              threadId: THREAD_ID,
              goalUpdatedAt: NOW,
              completedTurnId: TURN_ID,
            }),
          ),
          threadId: THREAD_ID,
          completedTurnId: TURN_ID,
        });
      }),
    ),
  );

  it.live("leaves a running Turn alone when its Session is fresh from this process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const freshSessionUpdatedAt = yield* Effect.map(Clock.currentTimeMillis, (millis) =>
          new Date(millis + 60_000).toISOString(),
        );
        const harness = yield* createHarness([
          makeThread({
            goal: activeGoal(),
            latestTurn: {
              turnId: TURN_ID,
              state: "running",
              requestedAt: freshSessionUpdatedAt,
              startedAt: freshSessionUpdatedAt,
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              threadId: THREAD_ID,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TURN_ID,
              lastError: null,
              updatedAt: freshSessionUpdatedAt,
            },
          }),
        ]);
        yield* harness.drain;
        expect(harness.dispatch).not.toHaveBeenCalled();
      }),
    ),
  );

  it.live("does not settle an orphaned Turn when the Goal is paused", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* createHarness([
          makeThread({
            goal: activeGoal("paused"),
            latestTurn: {
              turnId: TURN_ID,
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              threadId: THREAD_ID,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TURN_ID,
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ]);
        yield* harness.drain;
        expect(harness.dispatch).not.toHaveBeenCalled();
      }),
    ),
  );
});
