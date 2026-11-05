import type {
  MessageId,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  ScheduledTaskError,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import { isScheduledTaskMessageId, scheduledRunFailureReason } from "./scheduledTaskRun.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

export class ScheduledTaskRunReactor extends Context.Service<
  ScheduledTaskRunReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly reconcile: Effect.Effect<void>;
  }
>()("t3/scheduledTasks/ScheduledTaskRunReactor") {}

function latestContinuation(
  runs: ReadonlyArray<OrchestrationV2Run>,
  run: OrchestrationV2Run,
): OrchestrationV2Run {
  const next = runs.find((candidate) => candidate.restartContinuationOfRunId === run.id);
  return next === undefined ? run : latestContinuation(runs, next);
}

function originalMessageId(
  runs: ReadonlyArray<OrchestrationV2Run>,
  run: OrchestrationV2Run,
): MessageId {
  const source = runs.find((candidate) => candidate.id === run.restartContinuationOfRunId);
  return source === undefined ? run.userMessageId : originalMessageId(runs, source);
}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const tasks = yield* ScheduledTaskService.ScheduledTaskService;
  const scope = yield* Effect.scope;

  const settle = Effect.fnUntraced(function* (
    threadId: ThreadId,
    messageId: MessageId,
  ): Effect.fn.Return<void, ProjectionStore.ProjectionStoreV2Error | ScheduledTaskError> {
    const { messages, runs } = yield* projections.getThreadRecords(threadId, ["messages", "runs"], {
      messageIds: [messageId],
    });
    const message = messages.find((candidate) => candidate.id === messageId);
    const taskId = message?.scheduledTaskId;
    const source = runs.find((candidate) => candidate.id === message?.runId);
    // Steer cancels the queued run and moves its message into the active run, which is not ours.
    if (taskId === undefined || source?.userMessageId !== messageId) return;
    const run = latestContinuation(runs, source);
    if (yield* engine.restartContinuationPending(run)) {
      // A declined continuation emits no event, so its outcome needs a second look.
      yield* engine.awaitRestartContinuation(run).pipe(
        Effect.andThen(settle(threadId, messageId)),
        Effect.catchCause((cause) =>
          Effect.logWarning("recording a continued scheduled run failed", { taskId, cause }),
        ),
        Effect.forkIn(scope),
      );
      return;
    }
    const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"], {
      turnItemRunIds: [run.id],
      turnItemTypes: ["error", "run_interrupt_result"],
    });
    const error = scheduledRunFailureReason(run, turnItems);
    if (error !== null) yield* tasks.recordRunOutcome({ taskId, messageId, error });
  });

  // Runs for every domain event; everything but a scheduled run's bad ending returns before I/O.
  const handle: ScheduledTaskRunReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (
        event.type !== "run.updated" ||
        (event.payload.status !== "failed" &&
          event.payload.status !== "interrupted" &&
          event.payload.status !== "cancelled")
      ) {
        return;
      }
      const run = event.payload;
      if (isScheduledTaskMessageId(run.userMessageId)) {
        return yield* settle(event.threadId, run.userMessageId);
      }
      if (run.restartContinuationOfRunId === undefined) return;
      const { runs } = yield* projections.getThreadRecords(event.threadId, ["runs"]);
      const messageId = originalMessageId(runs, run);
      if (isScheduledTaskMessageId(messageId)) yield* settle(event.threadId, messageId);
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("recording a scheduled run's outcome failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const reconcile: ScheduledTaskRunReactor["Service"]["reconcile"] = Effect.suspend(() =>
    tasks.listDispatchedMessages(),
  ).pipe(
    Effect.flatMap((dispatched) =>
      Effect.forEach(
        dispatched,
        ({ threadId, messageId }) =>
          settle(threadId, messageId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("catching up a scheduled run failed", { messageId, cause }),
            ),
          ),
        { discard: true },
      ),
    ),
    Effect.catchCause((cause) => Effect.logWarning("catching up scheduled runs failed", { cause })),
  );

  const start: ScheduledTaskRunReactor["Service"]["start"] = () =>
    forkParked(
      // Events are live only and recovery runs before this fiber unparks, so runs that ended
      // across the restart surface only through the reconcile.
      Effect.all(
        [
          Stream.runForEach(engine.streamDomainEvents, handle).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("scheduled run event stream failed", { cause }),
            ),
          ),
          reconcile,
        ],
        { concurrency: "unbounded", discard: true },
      ),
    );

  return { start, handle, reconcile } satisfies ScheduledTaskRunReactor["Service"];
});

export const layer = Layer.effect(ScheduledTaskRunReactor, make);
