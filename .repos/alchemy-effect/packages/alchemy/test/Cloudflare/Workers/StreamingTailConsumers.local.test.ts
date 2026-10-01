import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";

// Mirrors the marker logged by `fixtures/tail/streaming-tail-producer.ts` on
// every request. Duplicated (not imported) because the fixture's default
// export must be its only export — extra named exports become workerd
// top-level exports and fail startup validation.
const STREAM_TAIL_MARKER = "alchemy-local-streaming-tail-marker";

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

/** The recorded shape of one streamed `TailEvent` in a consumer session. */
interface RecordedTailEvent {
  invocationId?: string;
  event?: { type?: string; outcome?: string; message?: unknown };
}

/**
 * Under `alchemy dev` a Worker's `streamingTailConsumers` lower into
 * workerd's `streamingTails` service designators: each consumer script name
 * resolves through the dev registry proxy — the same path plain tails and
 * cross-worker service bindings take — and the consumer's `tailStream()`
 * handler receives the invocation's `onset` while the producer is still
 * executing, then every subsequent event ending with the terminal `outcome`,
 * exactly like the deployed `streaming_tail_consumers` setting. The consumer
 * records each completed session into a locally-emulated KV namespace and
 * serves it back on `/events`, so this exercises the full local roundtrip
 * with zero cloud calls.
 */
test.provider(
  "local producer streams events to its local streaming tail consumer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
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
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/tail/streaming-tail-producer.ts",
            ),
            streamingTailConsumers: [consumer],
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
      expect(deployed.producer.streamingTailConsumers).toEqual([
        { service: deployed.consumer.workerName },
      ]);
      expect(deployed.producer.tailConsumers).toBeUndefined();

      // Readiness probes for both freshly started workerds.
      expect(yield* getTextReady(deployed.consumer.url!)).toBe(
        "streaming-tail-consumer-ok",
      );
      expect(yield* getTextReady(deployed.producer.url!)).toBe(
        "streaming-producer-ok",
      );

      // Drive the producer and poll the consumer's read route until a full
      // session carrying the producer's log marker arrives. The producer's
      // registry proxy may pick the consumer up asynchronously — each poll
      // re-invokes the producer so early dropped sessions don't strand the
      // test.
      const client = yield* HttpClient.HttpClient;
      const sessions = yield* Effect.gen(function* () {
        yield* client.get(deployed.producer.url!).pipe(
          Effect.flatMap((res) => res.text),
          Effect.orDie,
        );
        const res = yield* client
          .get(`${deployed.consumer.url}/events`)
          .pipe(Effect.orDie);
        const body = (yield* res.json.pipe(Effect.orDie)) as {
          sessions?: unknown;
        };
        return Array.isArray(body.sessions) ? (body.sessions as string[]) : [];
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (sessions): boolean =>
            sessions.some((session) => session.includes(STREAM_TAIL_MARKER)),
          times: 20,
        }),
      );

      const session = sessions.find((s) => s.includes(STREAM_TAIL_MARKER));
      expect(session).toBeDefined();
      // The recorded session is the JSON-serialized event stream: the onset
      // handed to `tailStream()`, the console.log marker, and the terminal
      // outcome — all from one producer invocation.
      const events = JSON.parse(session!) as RecordedTailEvent[];
      const types = events.map((tailEvent) => tailEvent.event?.type);
      expect(types).toContain("onset");
      expect(types).toContain("outcome");
      const log = events.find((tailEvent) => tailEvent.event?.type === "log");
      expect(log).toBeDefined();
      expect(log?.event?.message).toEqual([STREAM_TAIL_MARKER]);
      const onset = events.find(
        (tailEvent) => tailEvent.event?.type === "onset",
      );
      // Every streamed event belongs to the onset's invocation.
      for (const tailEvent of events) {
        expect(tailEvent.invocationId).toBe(onset?.invocationId);
      }
      const outcome = events.find(
        (tailEvent) => tailEvent.event?.type === "outcome",
      );
      expect(outcome?.event?.outcome).toBe("ok");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
