import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as queues from "@distilled.cloud/cloudflare/queues";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import DeadLetterWorker, {
  ByNameQueue,
  ByRefQueue,
  ByResourceQueue,
  DeadLetters,
  type DeadLetterSource,
} from "./fixtures/dead-letter-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class NotYetDeadLettered extends Data.TaggedError("NotYetDeadLettered")<{
  received: string[];
}> {}

const sources: DeadLetterSource[] = ["resource", "ref", "name"];

/**
 * `consumeQueueMessages(queue, { deadLetterQueue })` accepts the dead-letter
 * queue as a Queue resource, a `Queue.ref(...)`, or its name. Each source
 * queue's handler always fails, so its message is dead-lettered and must
 * reach the dead-letter queue's own consumer (#2464).
 */
test.provider(
  "dead-letters by Queue resource, Queue.ref, and queue name reach the dead-letter consumer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The dead-letter queue must be in state for `Queue.ref` to resolve.
      yield* stack.deploy(DeadLetters);

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const deadLetters = yield* DeadLetters;
          const worker = yield* DeadLetterWorker;
          return {
            url: worker.url,
            deadLetterQueueName: deadLetters.queueName,
            sourceQueueIds: [
              (yield* ByResourceQueue).queueId,
              (yield* ByRefQueue).queueId,
              (yield* ByNameQueue).queueId,
            ],
          };
        }),
      );
      const baseUrl = out.url as string;

      // Out of band: each source queue's consumer names the dead-letter queue.
      const { accountId } = yield* yield* CloudflareEnvironment;
      for (const queueId of out.sourceQueueIds) {
        const consumers = yield* queues.listConsumers
          .items({ accountId, queueId })
          .pipe(Stream.runCollect);
        expect(
          Array.from(consumers).map((consumer) =>
            "deadLetterQueue" in consumer ? consumer.deadLetterQueue : undefined,
          ),
        ).toEqual([out.deadLetterQueueName]);
      }

      for (const source of sources) {
        const res = yield* HttpClient.execute(
          HttpClientRequest.post(`${baseUrl}/send/${source}`).pipe(
            HttpClientRequest.bodyText("poison"),
          ),
        ).pipe(
          Effect.flatMap((res) =>
            res.status === 202
              ? Effect.succeed(res)
              : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("3 seconds")]),
              Schedule.recurs(10),
            ]),
          }),
        );
        expect(res.status).toBe(202);
      }

      const expected = sources.map((source) => `${source}:poison`);
      const received = yield* HttpClient.get(`${baseUrl}/dead-letters`).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((res) => res.json),
        Effect.map((body) => (body as { received: string[] }).received),
        Effect.flatMap((received) =>
          expected.every((entry) => received.includes(entry))
            ? Effect.succeed(received)
            : Effect.fail(new NotYetDeadLettered({ received })),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("4 seconds")]),
            Schedule.recurs(15),
          ]),
        }),
      );
      // Queues deliver at least once, so a message can be recorded twice.
      expect([...new Set(received)].sort()).toEqual([...expected].sort());

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:queue",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 180_000,
  },
);
