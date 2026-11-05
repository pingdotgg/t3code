import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  type Click,
  type EnrichedClick,
  produceRoute,
  ResultQueue,
  SourceQueue,
} from "./queue-sink-shared.ts";

export interface RecorderSnapshot {
  /** Distinct indices observed (queues are at-least-once). */
  distinct: number;
  /** Every recorded message carried the transformed `doubled` field. */
  transformed: boolean;
}

/**
 * Records the indices that reach the result queue, per run. Persisted in DO
 * storage so the snapshot survives hibernation.
 */
export class QueueSinkRecorder extends Cloudflare.DurableObject<QueueSinkRecorder>()(
  "QueueSinkRecorder",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const seen = new Set((yield* state.storage.get<number[]>("seen")) ?? []);
      let transformed = (yield* state.storage.get<boolean>("transformed")) ?? true;
      return {
        record: Effect.fn(function* (clicks: EnrichedClick[]) {
          for (const click of clicks) {
            seen.add(click.index);
            transformed &&= click.doubled === click.index * 2;
          }
          yield* state.storage.put("seen", [...seen]);
          yield* state.storage.put("transformed", transformed);
        }),
        snapshot: () =>
          Effect.succeed({
            distinct: seen.size,
            transformed,
          } satisfies RecorderSnapshot),
      };
    });
  }),
) {}

/**
 * For up to ~12 seconds after a fresh deploy, Cloudflare can still run the
 * precreate placeholder version: queue batches fail with "Handler does not
 * export a queue() function", and a newly started recorder DO rejects
 * `record` ("The RPC receiver does not implement the method"). With the
 * default `retryDelay` of 0 the redeliveries are immediate, so a batch already
 * waiting (the Action's seed, the first `/produce`) can exhaust `maxRetries`
 * and be dropped before the real version takes over. Spacing the retries
 * gives each batch a ~30 second budget.
 */
const consumerSettings = {
  batchSize: 100,
  maxWaitTime: "1 second",
  maxRetries: 10,
  retryDelay: "3 seconds",
} as const;

const groupByRun = (clicks: ReadonlyArray<EnrichedClick>) => {
  const runs = new Map<string, EnrichedClick[]>();
  for (const click of clicks) {
    const group = runs.get(click.run) ?? [];
    group.push(click);
    runs.set(click.run, group);
  }
  return [...runs];
};

/**
 * Source → transform → sink in one Worker:
 *
 * - `POST /produce?run=K&count=N[&padding=B]` drains N clicks into the
 *   source queue through `QueueSink` (a single stream chunk, so the sink
 *   must split it into 100-message / 256 KB batches).
 * - The source consumer maps each click to an `EnrichedClick` and drains
 *   the batch into the result queue through a second `QueueSink`.
 * - The result consumer records the indices in the run's DO.
 * - `GET /count?run=K` reads the DO snapshot.
 */
export default class QueueSinkWorker extends Cloudflare.Worker<QueueSinkWorker>()(
  "QueueSinkWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const recorders = yield* QueueSinkRecorder;
    const source = yield* SourceQueue;
    const results = yield* ResultQueue;
    const clicks = yield* Cloudflare.Queues.QueueSink(source);
    const enriched = yield* Cloudflare.Queues.QueueSink(results);

    yield* Cloudflare.Queues.consumeQueueMessages<Click>(source, consumerSettings, (messages) =>
      messages.pipe(
        Stream.map((message): EnrichedClick => ({
          ...message.body,
          doubled: message.body.index * 2,
        })),
        Stream.run(enriched),
      ),
    );

    yield* Cloudflare.Queues.consumeQueueMessages<EnrichedClick>(
      results,
      consumerSettings,
      (messages) =>
        messages.pipe(
          Stream.map((message) => message.body),
          Stream.runCollect,
          Effect.flatMap((bodies) =>
            Effect.forEach(
              groupByRun(bodies),
              ([run, group]) =>
                recorders.getByName(run).record(
                  // Drop the padding before persisting.
                  group.map(({ padding: _, ...click }) => click),
                ),
              { discard: true },
            ),
          ),
        ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const run = url.searchParams.get("run") ?? "default";

        if (request.method === "POST" && url.pathname === "/produce") {
          return yield* produceRoute(clicks, url);
        }

        if (request.method === "GET" && url.pathname === "/count") {
          const snapshot = yield* recorders.getByName(run).snapshot();
          return yield* HttpServerResponse.json(snapshot);
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cloudflare.Queues.EventSourceLive, Cloudflare.Queues.QueueSinkBinding),
    ),
  ),
) {}
