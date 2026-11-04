import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { makeK2LocalAuth } from "@alchemy.run/cloudflare/K2/K2Http";
import { makeReadSubscriptionClient } from "@alchemy.run/cloudflare/K2/ReadSubscriptionHttp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as k2 from "@distilled.cloud/cloudflare/k2";
import { Action } from "alchemy/Action";
import { createHostRuntimeContext, ServerHost } from "alchemy/Runtime/Process";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { waitForStreamGone } from "./k2-test-utils.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const Event = Schema.Struct({ source: Schema.String, index: Schema.Number });
type Event = typeof Event.Type;

class NotConsumed extends Data.TaggedError("NotConsumed")<{ distinct: number }> {}

const decoder = new TextDecoder();

/**
 * The `*Local` layers end to end, from an Action: `WriteStreamLocal` and
 * `StreamSinkLocal` produce typed records, and `consumeStreamRecords`
 * (`StreamEventSourcePolling` over `ReadSubscriptionLocal`, on an in-process
 * `ServerHost`) consumes them. The handler fails once to exercise
 * nack → redelivery. The ReadSubscription client is then driven directly
 * against a second subscription.
 */
test.provider(
  "Local producers, consumeStreamRecords polling, and the ReadSubscription client",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const events = yield* Cloudflare.K2.Stream("LocalEvents", { http: true, schema: Event });
          const poller = yield* Cloudflare.K2.Subscription("Poller", {
            stream: events,
            startAt: "earliest",
          });
          const reader = yield* Cloudflare.K2.Subscription("Reader", {
            stream: events,
            startAt: "earliest",
          });

          const Roundtrip = Action(
            "Roundtrip",
            Effect.gen(function* () {
              const writer = yield* Cloudflare.K2.WriteStream(events);
              const sink = yield* Cloudflare.K2.StreamSink(events);

              const seen = new Set<string>();
              let failures = 0;
              const host = createHostRuntimeContext("Test.K2Host")("K2Host");
              yield* Cloudflare.K2.consumeStreamRecords(
                events,
                {
                  subscription: poller,
                  workerId: "alchemy-k2-poller",
                  idleBackoff: "500 millis",
                  concurrency: 2,
                },
                (records) =>
                  Effect.gen(function* () {
                    if (failures === 0) {
                      failures++;
                      return yield* Effect.fail("first delivery fails" as const);
                    }
                    yield* records.pipe(
                      Stream.runForEach((record) =>
                        Effect.sync(() => seen.add(`${record.value.source}:${record.value.index}`)),
                      ),
                    );
                  }),
              ).pipe(
                Effect.provide(
                  Layer.provideMerge(
                    Cloudflare.K2.StreamEventSourcePolling,
                    Layer.mergeAll(
                      Cloudflare.K2.ReadSubscriptionLocal,
                      Layer.succeed(ServerHost, host),
                    ),
                  ),
                ),
              );

              return Effect.fn(function* () {
                yield* writer.send([0, 1, 2, 3, 4].map((index) => ({ source: "writer", index })));
                yield* Stream.range(0, 19).pipe(
                  Stream.map((index): Event => ({ source: "sink", index })),
                  Stream.run(sink),
                );

                const { program } = yield* host.exports;
                const drained = Effect.suspend(() =>
                  seen.size >= 25
                    ? Effect.succeed(seen.size)
                    : Effect.fail(new NotConsumed({ distinct: seen.size })),
                ).pipe(
                  Effect.retry({
                    schedule: Schedule.max([Schedule.spaced("1 second"), Schedule.recurs(60)]),
                  }),
                );
                const distinct = yield* Effect.raceFirst(
                  drained,
                  program.pipe(Effect.andThen(Effect.never)),
                );
                return { distinct, failures, seen: [...seen].sort() };
              });
            }).pipe(
              Effect.provide(
                Layer.mergeAll(Cloudflare.K2.WriteStreamLocal, Cloudflare.K2.StreamSinkLocal),
              ),
            ),
          );

          return {
            roundtrip: yield* Roundtrip({}),
            streamId: events.streamId,
            readerId: reader.subscriptionId,
          };
        }),
      );

      expect(out.roundtrip.distinct).toEqual(25);
      expect(out.roundtrip.failures).toEqual(1);
      expect(out.roundtrip.seen).toContain("writer:4");
      expect(out.roundtrip.seen).toContain("sink:19");

      // Drive the client directly (current credentials) on the reader.
      const auth = yield* makeK2LocalAuth;
      const client = makeReadSubscriptionClient(auth, {
        streamId: Effect.succeed(out.streamId),
        subscriptionId: Effect.succeed(out.readerId),
      });
      const consume = (workerId: string, maxRecords: number) =>
        client.consume({ workerId, maxRecords }).pipe(
          Effect.retry({
            while: (e) => e._tag === "K2BatchPending",
            schedule: Schedule.max([Schedule.spaced("500 millis"), Schedule.recurs(10)]),
          }),
        );

      const first = yield* consume("reader-a", 3);
      expect(Option.isSome(first)).toBe(true);
      const batch = Option.getOrThrow(first);
      expect(batch.records.length).toEqual(3);
      expect(JSON.parse(decoder.decode(batch.records[0]!.content))).toEqual({
        source: "writer",
        index: 0,
      });
      expect(batch.records[0]!.headers["content-type"]).toEqual("application/json");
      expect(batch.records[0]!.timestamp).toBeInstanceOf(Date);

      // The same worker gets the same batch back; extend refreshes the lease.
      const again = Option.getOrThrow(yield* consume("reader-a", 3));
      expect(again.batchId).toEqual(batch.batchId);
      const extended = yield* client.extend(batch);
      expect(extended.leasedUntil.getTime()).toBeGreaterThan(0);

      // nack → redelivered under a new batch id.
      yield* client.nack(batch);
      const redelivered = Option.getOrThrow(yield* consume("reader-a", 3));
      expect(redelivered.batchId).not.toEqual(batch.batchId);
      expect(redelivered.records.map((r) => decoder.decode(r.content))).toEqual(
        batch.records.map((r) => decoder.decode(r.content)),
      );

      // ack advances the subscription; acking twice succeeds; extending an
      // acknowledged batch is K2LeaseLost.
      yield* client.ack(redelivered);
      yield* client.ack(redelivered);
      const lost = yield* client.extend(redelivered).pipe(Effect.flip);
      expect(lost._tag).toEqual("K2LeaseLost");

      // Drain the rest; an empty subscription consumes None.
      const rest = Option.getOrThrow(yield* consume("reader-a", 1000));
      expect(rest.records.length).toEqual(22);
      yield* client.ack(rest);
      const empty = yield* consume("reader-a", 10);
      expect(Option.isNone(empty)).toBe(true);

      yield* stack.destroy();
      yield* waitForStreamGone(accountId, out.streamId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:k2", "live"], timeout: 120_000 },
);

// Deploy-time half of `consumeStreamRecords` without `subscription`: it
// declares a Subscription owned by the consuming host.
test.provider(
  "consumeStreamRecords creates a host-owned subscription",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const host = createHostRuntimeContext("Test.K2Host")("K2Host");
      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const events = yield* Cloudflare.K2.Stream("AutoEvents");
          yield* Cloudflare.K2.consumeStreamRecords(events, { startAt: "earliest" }, (records) =>
            Stream.runDrain(records),
          ).pipe(
            Effect.provide(
              Layer.provideMerge(
                Cloudflare.K2.StreamEventSourcePolling,
                Layer.mergeAll(
                  Cloudflare.K2.ReadSubscriptionLocal,
                  Layer.succeed(ServerHost, host),
                  // A real host provides its runtime context; outputs the
                  // client reads are bound into the host's env.
                  Layer.succeed(RuntimeContext, host),
                ),
              ),
            ),
          );
          return { streamId: events.streamId };
        }),
      );

      const subscriptions = yield* k2.listSubscriptions({ streamId: out.streamId });
      expect(subscriptions.length).toEqual(1);
      expect(subscriptions[0]?.startAt.type).toEqual("earliest");

      yield* stack.destroy();
      yield* waitForStreamGone(accountId, out.streamId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:k2", "live"], timeout: 120_000 },
);
