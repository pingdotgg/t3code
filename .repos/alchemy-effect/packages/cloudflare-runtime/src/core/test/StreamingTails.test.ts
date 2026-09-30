/**
 * Tests for streaming tail workers (`RuntimeWorker.streamingTails`, the
 * deployed `streaming_tail_consumers` setting).
 *
 * Contract delta from plain tails (`test/Tails.test.ts`): a plain tail
 * consumer exports `tail(items)` and receives completed `TraceItem`s after
 * the producer's invocation finishes, while a streaming tail consumer exports
 * `tailStream(event)`, which is invoked with the invocation's `onset` event
 * while the producer is still executing and returns a handler that receives
 * every subsequent event of the session, ending with the terminal `outcome`.
 *
 * Topology: every worker runs in its own workerd instance, so
 * `streamingTails` designators point at the registry proxy's
 * `ExternalService` entrypoint, whose `tailStream()` forwards the session to
 * the consumer's process via the workerd debug port (the remote handler comes
 * back as an RPC stub). A consumer that is not running yet is not a config
 * error: sessions are dropped with a warning until the consumer registers
 * itself, which the second test pins.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Docker from "../Docker.ts";
import * as Globals from "../globals/Globals.ts";
import * as Internet from "../globals/Internet.ts";
import * as Storage from "../globals/Storage.ts";
import * as Paths from "../internal/Paths.ts";
import * as Runtime from "../Runtime.ts";
import * as Workerd from "../workerd/Workerd.ts";
import {
  configProvider,
  localRuntimeLayer,
  makeTempDirectory,
  poll,
  PredicateFailed,
  startTestWorker,
  waitForRegistryEntry,
} from "./helpers/runtime.ts";

/** The shape of a JSON-serialized streaming `TailEvent` as recorded by the consumer. */
interface RecordedTailEvent {
  invocationId?: string;
  timestamp?: string;
  sequence?: number;
  event?: {
    type?: string;
    outcome?: string;
    level?: string;
    message?: unknown;
    info?: { type?: string; url?: string; method?: string };
  };
}

/**
 * Records every streamed event — the `onset` handed to `tailStream()` plus
 * every event delivered to the returned handler — and serves them back via
 * `GET /events`.
 */
const CONSUMER_SCRIPT = `
const events = [];
export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/events") return Response.json(events);
    return new Response("consumer");
  },
  tailStream(event) {
    events.push(event);
    return (tailEvent) => {
      events.push(tailEvent);
    };
  },
};
`;

const producerScript = (marker: string) => `
export default {
  fetch() {
    console.log(${JSON.stringify(marker)});
    return new Response("hello from producer");
  },
};
`;

const baseWorker = {
  compatibilityDate: "2026-03-10",
  compatibilityFlags: [],
  bindings: [],
} as const;

const consumerWorker = (name: string) => ({
  ...baseWorker,
  name,
  modules: [
    { name: "main.js", type: "ESModule", content: CONSUMER_SCRIPT } as const,
  ],
});

const producerWorker = (name: string, consumer: string, marker: string) => ({
  ...baseWorker,
  name,
  streamingTails: [consumer],
  modules: [
    {
      name: "main.js",
      type: "ESModule",
      content: producerScript(marker),
    } as const,
  ],
});

const eventTypes = (events: ReadonlyArray<RecordedTailEvent>) =>
  events.map((tailEvent) => tailEvent.event?.type);

layer(localRuntimeLayer, { excludeTestServices: true })(
  "Streaming tail workers",
  (it) => {
    it.effect(
      "streams onset and outcome events from a producer to its streaming tail consumer",
      () =>
        Effect.gen(function* () {
          const consumer = yield* startTestWorker(
            consumerWorker("streaming-tails-consumer"),
          );
          yield* waitForRegistryEntry({
            kind: "worker",
            scriptName: "streaming-tails-consumer",
          });

          const producer = yield* startTestWorker(
            producerWorker(
              "streaming-tails-producer",
              "streaming-tails-consumer",
              "streaming-tails-basic-marker",
            ),
          );
          expect(yield* producer.fetchText("/hello")).toBe(
            "hello from producer",
          );

          // The outcome event lands after the response completes; poll until
          // the consumer has recorded a full session (onset through outcome).
          const events = yield* poll<Array<RecordedTailEvent>>(
            consumer,
            "/events",
            (recorded) => eventTypes(recorded).includes("outcome"),
            20_000,
          );

          const onset = events.find(
            (tailEvent) => tailEvent.event?.type === "onset",
          );
          expect(onset).toBeDefined();
          expect(onset?.event?.info?.type).toBe("fetch");
          expect(onset?.event?.info?.url).toContain("/hello");
          expect(onset?.invocationId).toBeTruthy();

          const log = events.find(
            (tailEvent) => tailEvent.event?.type === "log",
          );
          expect(log?.event?.message).toEqual(["streaming-tails-basic-marker"]);

          const outcome = events.find(
            (tailEvent) => tailEvent.event?.type === "outcome",
          );
          expect(outcome?.event?.outcome).toBe("ok");

          // Every streamed event belongs to the same invocation as the onset.
          for (const tailEvent of events) {
            expect(tailEvent.invocationId).toBe(onset?.invocationId);
          }
        }),
      { timeout: 60_000 },
    );

    it.effect(
      "drops sessions while the consumer is down and streams once it starts",
      () =>
        Effect.gen(function* () {
          // The consumer is not running yet: starting the producer and serving
          // requests must both succeed — sessions are dropped with a warning.
          const producer = yield* startTestWorker(
            producerWorker(
              "streaming-tails-late-producer",
              "streaming-tails-late-consumer",
              "streaming-tails-late-marker",
            ),
          );
          expect(yield* producer.fetchText("/hello")).toBe(
            "hello from producer",
          );

          const consumer = yield* startTestWorker(
            consumerWorker("streaming-tails-late-consumer"),
          );
          yield* waitForRegistryEntry({
            kind: "worker",
            scriptName: "streaming-tails-late-consumer",
          });

          // The producer's registry proxy picks the consumer up asynchronously;
          // keep producing until a full session lands.
          const events = yield* producer.fetch("/hello").pipe(
            Effect.andThen(
              consumer.fetchJson<Array<RecordedTailEvent>>("/events"),
            ),
            Effect.flatMap((recorded) =>
              eventTypes(recorded).includes("outcome")
                ? Effect.succeed(recorded)
                : Effect.fail(new PredicateFailed({ value: recorded })),
            ),
            Effect.retry({
              while: (error) => error._tag === "PredicateFailed",
              schedule: Schedule.spaced("250 millis"),
              times: 120,
            }),
          );
          const log = events.find(
            (tailEvent) => tailEvent.event?.type === "log",
          );
          expect(log?.event?.message).toEqual(["streaming-tails-late-marker"]);
        }),
      { timeout: 90_000 },
    );
  },
);

// A runtime composed without the registry proxy plugin (`streamingTails` has
// nothing to resolve through) must fail fast with a typed `ConfigError`
// instead of silently starting a worker whose streaming tail sessions go
// nowhere. This lives outside the `layer(localRuntimeLayer)` suite:
// `PluginContext.make` also picks plugins up from the ambient effect context,
// so the suite's registry proxy would leak into the deliberately
// registry-free runtime below.
describe("Streaming tail workers without a registry proxy", () => {
  const noRegistryRuntimeLayer = Runtime.RuntimeLive.pipe(
    Layer.provide(Globals.GlobalsLive),
    Layer.provide(
      Layer.effect(
        Storage.Storage,
        Effect.suspend(() => makeTempDirectory()).pipe(
          Effect.map(Storage.make),
        ),
      ),
    ),
    Layer.provide(Internet.InternetLive),
    Layer.provideMerge(Paths.PathsLive),
    Layer.provideMerge(Docker.DockerLive),
    Layer.provide(Workerd.WorkerdLive),
    Layer.provide(configProvider()),
    Layer.provideMerge(
      Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer),
    ),
  );

  it.effect(
    "fails with ConfigError when streamingTails are declared without a registry proxy",
    () =>
      Effect.gen(function* () {
        const runtime = yield* Runtime.Runtime;
        const error = yield* runtime
          .start(
            producerWorker(
              "streaming-tails-no-registry",
              "streaming-tails-nowhere",
              "unused",
            ),
          )
          .pipe(Effect.flip);
        expect(error._tag).toBe("ConfigError");
        expect(error.subtag).toBe("PluginNotFound");
      }).pipe(Effect.provide(noRegistryRuntimeLayer), Effect.scoped),
    { timeout: 30_000 },
  );
});
