import { assert, it } from "@effect/vitest";
import { RunId, ThreadId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { followSettledSubagentRefreshes } from "./ModelEvaluationSubagentRefresh.ts";

const runId = RunId.make("parent-run");

const settledChild = {
  type: "turn-item.updated",
  threadId: ThreadId.make("parent-thread"),
  runId,
  payload: { type: "subagent", status: "completed", runId },
} as OrchestrationV2DomainEvent;

it.effect("keeps refreshing after the event stream fails", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const started = yield* Deferred.make<void>();
    const refreshed = yield* Deferred.make<RunId | undefined>();
    let subscriptions = 0;
    const fiber = yield* Effect.forkChild(
      followSettledSubagentRefreshes({
        evaluations: {
          enqueueSettledSubagentRefreshes: (input) =>
            input?.runId === undefined
              ? Effect.void
              : Deferred.succeed(refreshed, input.runId).pipe(Effect.asVoid),
        },
        orchestrator: {
          getLatestEventSequence: () => Deferred.succeed(started, undefined).pipe(Effect.as(0)),
          streamDomainEventsAfter: () => {
            subscriptions += 1;
            return subscriptions === 1
              ? Stream.fail(
                  new Orchestrator.OrchestratorDomainEventStreamError({
                    cause: new Error("subscription dropped"),
                  }),
                )
              : Stream.fromQueue(events);
          },
        },
      }),
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("1 second");
    yield* Queue.offer(events, settledChild);
    assert.equal(yield* Deferred.await(refreshed), runId);
    yield* Fiber.interrupt(fiber);
  }),
);
