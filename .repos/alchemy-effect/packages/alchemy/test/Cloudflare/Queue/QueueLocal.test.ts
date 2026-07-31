import { Action } from "@/Action";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";
import { poll } from "@/Util/poll.ts";
import * as queues from "@distilled.cloud/cloudflare/queues";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Sending to a Queue inside an Action via `WriteQueueLocal` — the local
// (current-credentials) implementation of the `WriteQueue` binding. Exercises
// both the binding client (send/sendBatch) and the accessor mechanism
// (`yield* queue.queueId` resolved at apply time). The producer binding is
// send-only, so we verify out-of-band by pulling the messages back off the
// queue through an HTTP-pull consumer.
test.provider(
  "WriteQueueLocal: send and sendBatch to a queue from an Action",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const marker = yield* Effect.sync(() => crypto.randomUUID());

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* Cloudflare.Queues.Queue("LocalWriteQueue");

          const Seed = Action(
            "Seed",
            Effect.gen(function* () {
              const q = yield* Cloudflare.Queues.WriteQueue(queue);
              // Accessor — resolved at apply time against the tracker.
              const queueId = yield* queue.queueId;

              return Effect.fn(function* () {
                const id = yield* queueId;

                // Register an HTTP-pull consumer so the test can pull the
                // messages back out-of-band. A brand-new queue can briefly
                // 404 the consumer create under load — ride out the lag.
                yield* queues
                  .createConsumer({
                    accountId,
                    queueId: id,
                    type: "http_pull",
                  })
                  .pipe(
                    Effect.retry({
                      while: (e) => e._tag === "QueueNotFound",
                      schedule: Schedule.exponential("500 millis"),
                      times: 8,
                    }),
                    Effect.catchTag("ConsumerAlreadyExists", () => Effect.void),
                  );

                yield* q.send({ marker, seq: 1 });
                yield* q.sendBatch([
                  { body: { marker, seq: 2 } },
                  { body: { marker, seq: 3 } },
                ]);

                return { queueId: id };
              });
            }).pipe(Effect.provide(Cloudflare.Queues.WriteQueueLocal)),
          );

          return yield* Seed({});
        }),
      );

      expect(out.queueId).toBeTruthy();

      // Out-of-band verification: pull the messages back off the queue and
      // assert all three payloads (carrying our unique marker) arrive. Pulls
      // lease a subset per call, so accumulate distinct bodies across polls.
      const collected = new Set<string>();
      yield* poll({
        description: "pull sent messages back off the queue",
        effect: Effect.gen(function* () {
          const res = yield* queues.pullMessage({
            accountId,
            queueId: out.queueId,
            batchSize: 10,
            visibilityTimeoutMs: 2_000,
          });
          for (const m of res.messages ?? []) {
            if (m.body) collected.add(m.body);
          }
          const acks = (res.messages ?? [])
            .filter((m): m is typeof m & { leaseId: string } => !!m.leaseId)
            .map((m) => ({ leaseId: m.leaseId }));
          if (acks.length > 0) {
            yield* queues.ackMessage({ accountId, queueId: out.queueId, acks });
          }
          return collected.size;
        }),
        predicate: (size) => size >= 3,
        schedule: Schedule.max([
          Schedule.spaced("2 seconds"),
          Schedule.recurs(30),
        ]),
      });

      expect(collected.size).toBeGreaterThanOrEqual(3);
      for (const body of collected) {
        expect(body).toContain(marker);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
