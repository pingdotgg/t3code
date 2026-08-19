import {
  CommandId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  countTrailingEmptyGoalContinuations,
  EMPTY_GOAL_CONTINUATION_LIMIT,
  goalBlockCommandId,
  goalContinuationCommandId,
} from "@t3tools/shared/goalContinuation";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { hasOpenBlockingRequest, isThreadIdleForGoal } from "./decider.ts";
import { forkParked, ServerActivation } from "../serverActivation.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

/**
 * GoalReactor - Continuation reaction service.
 *
 * Owns a background worker that reacts to Session-ready domain events and
 * requests a Continuation when a Goal is Active.
 */
export class GoalReactor extends Context.Service<
  GoalReactor,
  {
    /**
     * Start reacting to Session-ready orchestration domain events.
     *
     * The returned effect must be run in a scope so all worker fibers can be
     * finalized on shutdown.
     */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;

    /**
     * Resolves when the internal processing queue is empty and idle.
     * Intended for test use to replace timing-sensitive sleeps.
     */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/GoalReactor") {}

type SessionSetEvent = Extract<OrchestrationEvent, { type: "thread.session-set" }>;

export const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  // Layer construction happens at process boot, so a Session last touched
  // before this timestamp belongs to a previous, now-dead process.
  const processStartedAtMs = yield* Clock.currentTimeMillis;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const dispatchGoalCommand = Effect.fn("dispatchGoalCommand")(function* (
    command: Parameters<typeof orchestrationEngine.dispatch>[0],
    warning: string,
    threadId: string,
  ) {
    yield* orchestrationEngine.dispatch(command).pipe(
      // Stale/duplicate evaluations are part of the design (stable command
      // ids); only unexpected failures are worth a warning.
      Effect.catchTags({
        OrchestrationCommandInvariantError: () => Effect.void,
        OrchestrationCommandPreviouslyRejectedError: () => Effect.void,
      }),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(warning, {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );
  });

  const evaluateGoalContinuation = Effect.fn("evaluateGoalContinuation")(function* (
    thread: OrchestrationThread,
    occurredAt: string,
  ) {
    const goal = thread.goal;
    if (goal?.status !== "active") {
      return;
    }
    if (thread.interactionMode === "plan") {
      return;
    }
    if (hasOpenBlockingRequest(thread)) {
      return;
    }
    if (!isThreadIdleForGoal(thread, occurredAt)) {
      return;
    }
    const completedTurnId = thread.latestTurn?.turnId;
    if (completedTurnId == null || thread.latestTurn?.state === "running") {
      return;
    }

    if (countTrailingEmptyGoalContinuations(thread, occurredAt) >= EMPTY_GOAL_CONTINUATION_LIMIT) {
      yield* dispatchGoalCommand(
        {
          type: "thread.goal.block",
          commandId: CommandId.make(
            goalBlockCommandId({
              threadId: thread.id,
              goalUpdatedAt: goal.updatedAt,
              completedTurnId,
            }),
          ),
          threadId: thread.id,
        },
        "goal reactor failed to Block after empty Continuations",
        thread.id,
      );
      return;
    }

    yield* dispatchGoalCommand(
      {
        type: "thread.goal.continue",
        commandId: CommandId.make(
          goalContinuationCommandId({
            threadId: thread.id,
            goalUpdatedAt: goal.updatedAt,
            completedTurnId,
          }),
        ),
        threadId: thread.id,
        completedTurnId,
      },
      "goal reactor failed to request Continuation",
      thread.id,
    );
  });

  const processSessionSet = Effect.fn("processSessionSet")(function* (event: SessionSetEvent) {
    if (event.payload.session.status !== "ready") {
      return;
    }

    const thread = yield* projectionSnapshotQuery
      .getThreadDetailById(event.payload.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread) {
      return;
    }
    yield* evaluateGoalContinuation(thread, event.occurredAt);
  });

  const processSessionSetSafely = (event: SessionSetEvent) =>
    processSessionSet(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("goal reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processSessionSetSafely);

  // A Turn that was running when the previous process exited never receives
  // the session-set that ends it, so it reads "running" forever and an Active
  // Goal on the thread wedges: no continuation fires and the idle guard keeps
  // rejecting new ones. Settle the phantom Turn, then resume the Goal.
  const resumeInterruptedGoalThread = Effect.fn("resumeInterruptedGoalThread")(function* (
    shell: OrchestrationThreadShell,
  ) {
    const latestTurn = shell.latestTurn;
    if (shell.goal?.status !== "active" || latestTurn?.state !== "running") {
      return;
    }
    // Both the Session touch and the Turn request must predate this process;
    // otherwise the running Turn belongs to a live Session started after boot
    // and settling it would corrupt real work.
    if (Date.parse(latestTurn.requestedAt) >= processStartedAtMs) {
      return;
    }
    if (shell.session !== null && Date.parse(shell.session.updatedAt) >= processStartedAtMs) {
      return;
    }
    const occurredAt = yield* nowIso;
    const settleResult = yield* Effect.exit(
      orchestrationEngine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`goal-restart-settle:${shell.id}:${latestTurn.turnId}`),
        threadId: shell.id,
        session: {
          threadId: shell.id,
          status: "interrupted",
          providerName: shell.session?.providerName ?? null,
          ...(shell.session?.providerInstanceId !== undefined
            ? { providerInstanceId: shell.session.providerInstanceId }
            : {}),
          runtimeMode: shell.session?.runtimeMode ?? shell.runtimeMode,
          activeTurnId: null,
          lastError: shell.session?.lastError ?? null,
          updatedAt: occurredAt,
        },
        createdAt: occurredAt,
      }),
    );
    if (Exit.isFailure(settleResult)) {
      if (Cause.hasInterruptsOnly(settleResult.cause)) {
        return yield* Effect.interrupt;
      }
      // The sweep is one-shot per boot, so a rejected settle must not fall
      // through to the continuation: the real Turn is still running and the
      // continuation would be rejected against it anyway.
      yield* Effect.logWarning("goal reactor failed to settle a Turn orphaned by restart", {
        threadId: shell.id,
        cause: Cause.pretty(settleResult.cause),
      });
      return;
    }
    yield* Effect.logInfo("goal reactor settled a Turn orphaned by restart", {
      threadId: shell.id,
      turnId: latestTurn.turnId,
    });

    const thread = yield* projectionSnapshotQuery
      .getThreadDetailById(shell.id)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread) {
      return;
    }
    // The SQLite projection may not have consumed the settle yet, so evaluate
    // against the state the settle produces rather than the stale read.
    yield* evaluateGoalContinuation(
      {
        ...thread,
        latestTurn:
          thread.latestTurn !== null && thread.latestTurn.turnId === latestTurn.turnId
            ? { ...thread.latestTurn, state: "interrupted", completedAt: occurredAt }
            : thread.latestTurn,
        session:
          thread.session !== null
            ? { ...thread.session, status: "interrupted", activeTurnId: null }
            : thread.session,
      },
      occurredAt,
    );
  });

  // Boot-time catch-up for everything the live event path can miss: a Turn
  // orphaned by the previous process (settled above) and an idle Active Goal
  // whose continuation trigger raced startup (the projection is consistent
  // here, and the decider dedupes any Continuation already requested).
  const resumeInterruptedGoals = Effect.gen(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    yield* Effect.forEach(snapshot.threads, resumeInterruptedGoalThread, {
      discard: true,
    });
    yield* Effect.forEach(
      snapshot.threads,
      Effect.fn("resumeIdleGoalThread")(function* (shell: OrchestrationThreadShell) {
        if (shell.goal?.status !== "active" || shell.latestTurn?.state === "running") {
          return;
        }
        const thread = yield* projectionSnapshotQuery
          .getThreadDetailById(shell.id)
          .pipe(Effect.map(Option.getOrUndefined));
        if (!thread) {
          return;
        }
        const occurredAt = yield* nowIso;
        yield* evaluateGoalContinuation(thread, occurredAt);
      }),
      { discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.interrupt;
      }
      return Effect.logWarning("goal reactor failed to resume Goals after restart", {
        cause: Cause.pretty(cause),
      });
    }),
  );

  const start: GoalReactor["Service"]["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.session-set") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      yield* resumeInterruptedGoals;
    } else {
      yield* forkParked(resumeInterruptedGoals);
    }
  });

  return {
    start,
    drain: worker.drain,
  } satisfies GoalReactor["Service"];
});

export const layer = Layer.effect(GoalReactor, make);
