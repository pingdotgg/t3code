import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import * as kv from "@distilled.cloud/cloudflare/kv";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as pathe from "pathe";
import { expectUrlContains } from "../Utils/Http.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * Producer: logs on every request so each invocation produces a streaming
 * tail session (onset → log → outcome) for its streaming tail consumers.
 */
const producerScript = `export default {
  fetch() {
    console.log("alchemy-streaming-tail-marker");
    return new Response("streaming-producer-ok");
  },
};`;

/** The recorded shape of one streamed `TailEvent` in a consumer session. */
interface RecordedTailEvent {
  invocationId?: string;
  event?: { type?: string; outcome?: string; message?: unknown };
}

/**
 * Cloud-side `tailStream()` delivery is not yet available: Cloudflare's
 * production API refuses the `streaming_tail_worker` compatibility flag —
 * the flag that enables workerd's streaming tail model — with the typed
 * `ScriptStartupError` (code 10021) "The compatibility flag
 * streaming_tail_worker is experimental and cannot yet be used in Workers
 * deployed to Cloudflare." A deployed consumer therefore cannot opt into
 * the `tailStream()` handler, so no events are ever delivered to it. The
 * ungated probe test below pins that exact rejection.
 *
 * Probed 2026-08-04 on the testing account: the `streaming_tail_consumers`
 * metadata PUT succeeds and the producer serves, but producer invocations
 * delivered ZERO streaming sessions across 5 minutes of polling (60 × 5s,
 * each poll re-invoking the producer) — with and without
 * `observability.traces.enabled` on the producer — while a plain `tail()`
 * consumer on the same account delivers within seconds
 * (TailConsumers.test.ts, green). Local workerd delivery is real and
 * covered by StreamingTailConsumers.local.test.ts. Set this env var once
 * Cloudflare ships production delivery (the probe test will fail then) to
 * assert delivery end-to-end.
 */
const STREAMING_TAIL_DELIVERY =
  !!process.env.CLOUDFLARE_TEST_STREAMING_TAIL_DELIVERY;

/**
 * Ungated platform probe: production refuses the experimental
 * `streaming_tail_worker` compatibility flag, which is the root cause of
 * zero cloud-side `tailStream()` delivery (a deployed consumer cannot
 * enable the streaming tail model). The day this test FAILS — the flag
 * deploys, or the rejection changes shape — streaming tail workers have
 * shipped (or changed): re-verify delivery with
 * CLOUDFLARE_TEST_STREAMING_TAIL_DELIVERY=1 and drop the gate above.
 */
test.provider(
  "production refuses the streaming_tail_worker compatibility flag (probe)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("StreamingTailFlagProbe", {
              script: producerScript,
              compatibility: { flags: ["streaming_tail_worker"] },
            });
          }),
        )
        .pipe(Effect.flip);

      expect(error._tag).toEqual("ScriptStartupError");
      if (error._tag === "ScriptStartupError") {
        expect(error.message).toContain(
          "streaming_tail_worker is experimental and cannot yet be used",
        );
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

/**
 * `streamingTailConsumers` uploads `streaming_tail_consumers` in the script
 * metadata. Unlike plain `tail_consumers`, the script-settings read endpoint
 * does not expose the field, so the attachment is asserted through the
 * recorded attribute plus (when `CLOUDFLARE_TEST_STREAMING_TAIL_DELIVERY` is
 * set) actual delivery: the consumer's `tailStream()` persists each completed
 * session into KV, observed out-of-band via distilled KV reads.
 */
test.provider(
  "worker with streamingTailConsumers attaches and detaches the consumer (delivery gated)",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployStack = (tails: "attached" | "detached") =>
        Effect.gen(function* () {
          const events = yield* Cloudflare.KV.Namespace("StreamTailEvents");
          const consumer = yield* Cloudflare.Worker("StreamingTailConsumer", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/tail/streaming-tail-consumer.ts",
            ),
            env: { EVENTS: events },
          });
          const producer = yield* Cloudflare.Worker("StreamingTailProducer", {
            script: producerScript,
            streamingTailConsumers: tails === "attached" ? [consumer] : [],
          });
          return { events, consumer, producer };
        });

      const v1 = yield* stack.deploy(deployStack("attached"));

      // The upload carried `streaming_tail_consumers` (the PUT would have
      // failed otherwise) and the attribute records the consumer by deployed
      // script name. GET script-settings has no field for streaming
      // consumers, so there is no out-of-band settings read to assert
      // against — the gated delivery assertion below is the only cloud-side
      // proof of attachment available.
      expect(v1.producer.streamingTailConsumers).toEqual([
        { service: v1.consumer.workerName },
      ]);
      expect(v1.producer.tailConsumers ?? []).toEqual([]);

      // The producer serves with the streaming consumer attached — the
      // attachment never breaks the producer's own deploy or execution.
      yield* expectUrlContains(v1.producer.url!, "streaming-producer-ok", {
        label: "streaming tail producer",
      });

      // Delivery assertion — gated (see STREAMING_TAIL_DELIVERY above).
      if (STREAMING_TAIL_DELIVERY) {
        // Poll KV until a completed streaming session lands. Each poll
        // re-invokes the producer so delivery that begins slightly after the
        // first request still surfaces.
        const eventKeys = yield* Effect.gen(function* () {
          yield* expectUrlContains(v1.producer.url!, "streaming-producer-ok", {
            timeout: "15 seconds",
            label: "streaming tail producer (poll)",
          });
          const keys = yield* kv.listNamespaceKeys({
            accountId,
            namespaceId: v1.events.namespaceId,
            prefix: "evt:",
          });
          return keys.result.map((k) => k.name);
        }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (keys): boolean => keys.length > 0,
            times: 18,
          }),
        );
        expect(eventKeys.length).toBeGreaterThan(0);

        // The recorded session is a full onset → log → outcome stream from
        // one producer invocation, carrying the producer's log marker.
        const session = yield* kv
          .getNamespaceValue({
            accountId,
            namespaceId: v1.events.namespaceId,
            keyName: eventKeys[0],
          })
          .pipe(
            Effect.flatMap((res) =>
              Effect.tryPromise(() =>
                new Response(
                  Stream.toReadableStream(res.body) as BodyInit,
                ).text(),
              ),
            ),
          );
        expect(session).toContain("alchemy-streaming-tail-marker");
        const events = JSON.parse(session) as RecordedTailEvent[];
        const types = events.map((tailEvent) => tailEvent.event?.type);
        expect(types).toContain("onset");
        expect(types).toContain("outcome");
        const log = events.find((tailEvent) => tailEvent.event?.type === "log");
        expect(log?.event?.message).toEqual(["alchemy-streaming-tail-marker"]);
      }

      // Detaching every consumer is an in-place update, never a replace.
      const v2 = yield* stack.deploy(deployStack("detached"));
      expect(v2.producer.workerId).toEqual(v1.producer.workerId);
      expect(v2.producer.workerName).toEqual(v1.producer.workerName);
      expect(v2.producer.streamingTailConsumers ?? []).toEqual([]);

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(v1.producer.workerName, accountId);
      yield* waitForWorkerToBeDeleted(v1.consumer.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 240_000 },
);
