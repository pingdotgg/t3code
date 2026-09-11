import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";

// Mirrors the marker logged by `fixtures/tail/tail-producer.ts` on every
// request. Duplicated (not imported) because the fixture's default export
// must be its only export — extra named exports become workerd top-level
// exports and fail startup validation.
const TAIL_MARKER = "alchemy-local-tail-marker";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

/** GET a route, retrying until the freshly started workerd serves a 200. */
const getTextReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(10),
        ]),
      }),
    );
    return yield* res.text;
  }).pipe(Effect.orDie);

/**
 * Under `alchemy dev` a Worker's `tailConsumers` lower into workerd's native
 * `tails` service designators: each consumer script name resolves through
 * the dev registry proxy — the same path cross-worker service bindings take —
 * and the producer's trace events are delivered to the consumer's `tail()`
 * handler after each response, exactly like the deployed `tail_consumers`
 * setting. The consumer records each batch into a locally-emulated KV
 * namespace and serves it back on `/events`, so this exercises the full
 * local roundtrip with zero cloud calls.
 */
test.provider(
  "local producer delivers trace events to its local tail consumer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const events = yield* Cloudflare.KV.Namespace("TailEvents");
          const consumer = yield* Cloudflare.Worker("TailConsumer", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/tail/tail-consumer.ts",
            ),
            env: { EVENTS: events },
          });
          const producer = yield* Cloudflare.Worker("TailProducer", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/tail/tail-producer.ts",
            ),
            tailConsumers: [consumer],
          });
          return { events, consumer, producer };
        }),
      );

      // Dev markers: the KV namespace is locally emulated (no cloud call
      // ran), and both workers serve from the local dev proxy.
      expect(deployed.events.namespaceId).toMatch(/^dev:/);
      expect(deployed.consumer.url).toMatch(/^http:\/\/localhost:\d+$/);
      expect(deployed.producer.url).toMatch(/^http:\/\/localhost:\d+$/);

      // Attribute parity with the live provider: the consumer is recorded
      // by script name.
      expect(deployed.producer.tailConsumers).toEqual([
        { service: deployed.consumer.workerName },
      ]);

      // Readiness probes for both freshly started workerds.
      expect(yield* getTextReady(deployed.consumer.url!)).toBe(
        "tail-consumer-ok",
      );
      expect(yield* getTextReady(deployed.producer.url!)).toBe("producer-ok");

      // Drive the producer and poll the consumer's read route until a trace
      // batch carrying the producer's log marker arrives. Delivery is
      // near-immediate once both are registered, but the producer's registry
      // proxy may pick the consumer up asynchronously — each poll re-invokes
      // the producer so early dropped events don't strand the test.
      const client = yield* HttpClient.HttpClient;
      const batches = yield* Effect.gen(function* () {
        yield* client.get(deployed.producer.url!).pipe(
          Effect.flatMap((res) => res.text),
          Effect.orDie,
        );
        const res = yield* client
          .get(`${deployed.consumer.url}/events`)
          .pipe(Effect.orDie);
        const body = (yield* res.json.pipe(Effect.orDie)) as {
          batches?: unknown;
        };
        return Array.isArray(body.batches) ? (body.batches as string[]) : [];
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (batches): boolean =>
            batches.some((batch) => batch.includes(TAIL_MARKER)),
          times: 20,
        }),
      );

      const batch = batches.find((batch) => batch.includes(TAIL_MARKER));
      expect(batch).toBeDefined();
      // The recorded batch is the JSON-serialized TraceItem array from the
      // producer invocation — outcome + the console.log marker.
      const items = JSON.parse(batch!) as {
        outcome?: string;
        logs?: { message?: unknown[] }[];
      }[];
      expect(
        items.some((item) =>
          item.logs?.some((log) => log.message?.includes(TAIL_MARKER)),
        ),
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
