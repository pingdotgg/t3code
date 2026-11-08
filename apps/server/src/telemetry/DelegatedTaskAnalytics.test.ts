import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as DelegatedTaskAnalytics from "./DelegatedTaskAnalytics.ts";

// Task i finishes after i seconds, so each recorded durationSeconds names its task.
const finished = (i: number) =>
  ({
    type: "subagent.updated",
    payload: {
      id: `task-${i}`,
      threadId: ThreadId.make("parent"),
      origin: "app_owned",
      status: "completed",
      providerInstanceId: ProviderInstanceId.make("codex"),
      model: null,
      startedAt: DateTime.makeUnsafe(0),
      completedAt: DateTime.makeUnsafe(i * 1000),
    },
  }) as never;

it.effect("records each finished task once while remembering only recent tasks", () =>
  Effect.gen(function* () {
    const cap = 2048;
    const sentinel = cap + 1;
    const recorded: Array<unknown> = [];
    const sentinelRecorded = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<never>();

    yield* Layer.build(
      DelegatedTaskAnalytics.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.fromQueue(events),
              getThreadShell: () => Effect.succeed(null),
            }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(AnalyticsService.AnalyticsService)({
              record: (_event, properties) =>
                Effect.suspend(() => {
                  recorded.push(properties?.durationSeconds);
                  return properties?.durationSeconds === sentinel
                    ? Deferred.succeed(sentinelRecorded, undefined)
                    : Effect.void;
                }),
            }),
          ),
        ),
      ),
    );

    const tasks = Array.from({ length: cap + 1 }, (_, i) => i);
    for (const i of tasks) yield* Queue.offer(events, finished(i));
    yield* Queue.offer(events, finished(1));
    yield* Queue.offer(events, finished(0));
    yield* Queue.offer(events, finished(sentinel));
    yield* Deferred.await(sentinelRecorded);

    expect(recorded.slice(0, cap + 1)).toEqual(tasks);
    // Task 1 is the oldest still remembered, so its re-emit stays deduped; task 0 was evicted.
    expect(recorded.slice(cap + 1)).toEqual([0, sentinel]);
  }),
);
