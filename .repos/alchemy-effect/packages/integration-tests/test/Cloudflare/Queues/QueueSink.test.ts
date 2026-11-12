import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Action } from "alchemy/Action";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Stream from "effect/Stream";
import { awaitDrained, produce } from "./fixtures/queue-sink-client.ts";
import QueueSinkHttpWorker from "./fixtures/queue-sink-http-worker.ts";
import { type Click, SourceQueue } from "./fixtures/queue-sink-shared.ts";
import QueueSinkWorker from "./fixtures/queue-sink-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

/**
 * `Cloudflare.Queues.QueueSink` end to end against real Cloudflare Queues:
 * the fixture drains 250 clicks (one stream chunk, split into 100/100/50
 * `sendBatch` calls) into a source queue, a `consumeQueueMessages` handler
 * transforms each batch and drains it into a result queue through a second
 * `QueueSink`, and the result consumer records every index in a DO.
 *
 * A second run sends five ~100 KB messages, which only fit Cloudflare's
 * 256 KB batch limit when the sink splits them by size. Two more runs feed
 * the same pipeline through the other layers: `QueueSinkHttp` from a second
 * Worker, and `QueueSinkLocal` from an Action during deploy.
 */
test.provider.skipIf(!!process.env.FAST)(
  "QueueSink drains a stream through source → transform → sink",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { url, httpUrl } = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* SourceQueue;
          const worker = yield* QueueSinkWorker;
          const httpWorker = yield* QueueSinkHttpWorker;

          const Seed = Action(
            "Seed",
            Effect.gen(function* () {
              const sink = yield* Cloudflare.Queues.QueueSink(source);
              return Effect.fn(function* () {
                yield* Stream.range(0, 149).pipe(
                  Stream.map((index): Click => ({ run: "action", index })),
                  Stream.run(sink),
                );
              });
            }).pipe(Effect.provide(Cloudflare.Queues.QueueSinkLocal)),
          );
          yield* Seed({});

          return {
            url: worker.url.as<string>(),
            httpUrl: httpWorker.url.as<string>(),
          };
        }),
      );
      expect(url).toBeTypeOf("string");
      expect(httpUrl).toBeTypeOf("string");

      yield* produce(url, { run: "count", count: 250 });
      yield* produce(url, { run: "large", count: 5, padding: 100_000 });
      yield* produce(httpUrl, { run: "http", count: 150 });

      const [count, large, http, action] = yield* Effect.all(
        [
          awaitDrained(url, "count", 250),
          awaitDrained(url, "large", 5),
          awaitDrained(url, "http", 150),
          awaitDrained(url, "action", 150),
        ],
        { concurrency: "unbounded" },
      );

      // At-least-once delivery: assert distinct indices, not message count.
      expect(count).toEqual({ distinct: 250, transformed: true });
      expect(large).toEqual({ distinct: 5, transformed: true });
      expect(http).toEqual({ distinct: 150, transformed: true });
      expect(action).toEqual({ distinct: 150, transformed: true });

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:queue",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 200_000,
  },
);
