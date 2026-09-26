/**
 * Tests for tail workers (`RuntimeWorker.tails`, the deployed `tail_consumers`
 * setting — see the "tail consumer called" case in
 * `workers-sdk/packages/miniflare/test/index.spec.ts`).
 *
 * Topology delta from Miniflare: Miniflare hosts producer and consumer in one
 * workerd instance and points `tails` at the consumer's service directly. Here
 * every worker runs in its own workerd instance, so `tails` designators point
 * at the registry proxy's `ExternalService` entrypoint, which forwards
 * `tail()` events to the consumer's process via the workerd debug port — the
 * same path cross-process service bindings take. Consequently a consumer that
 * is not running yet is not a config error: events are dropped with a warning
 * until the consumer registers itself (mirroring `wrangler dev` registry
 * semantics), which the second test pins.
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

/** The shape of a JSON-serialized `TraceItem` as recorded by the consumer. */
interface RecordedTraceItem {
  outcome?: string;
  scriptName?: string | null;
  logs?: Array<{ level?: string; message?: Array<unknown> }>;
  event?: { request?: { url?: string; method?: string } } | null;
}

/** Records every `tail()` batch and serves it back via `GET /events`. */
const CONSUMER_SCRIPT = `
const events = [];
export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/events") return Response.json(events);
    return new Response("consumer");
  },
  tail(items) {
    events.push(...items);
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
  tails: [consumer],
  modules: [
    {
      name: "main.js",
      type: "ESModule",
      content: producerScript(marker),
    } as const,
  ],
});

layer(localRuntimeLayer, { excludeTestServices: true })(
  "Tail workers",
  (it) => {
    it.effect(
      "delivers trace events from a producer to its tail consumer",
      () =>
        Effect.gen(function* () {
          const consumer = yield* startTestWorker(
            consumerWorker("tails-consumer"),
          );
          yield* waitForRegistryEntry({
            kind: "worker",
            scriptName: "tails-consumer",
          });

          const producer = yield* startTestWorker(
            producerWorker(
              "tails-producer",
              "tails-consumer",
              "tails-basic-marker",
            ),
          );
          expect(yield* producer.fetchText("/hello")).toBe(
            "hello from producer",
          );

          // Tail events are delivered after the response completes; poll until
          // the consumer has recorded the batch.
          const events = yield* poll<Array<RecordedTraceItem>>(
            consumer,
            "/events",
            (items) => items.length > 0,
            20_000,
          );
          const item = events[0];
          expect(item.outcome).toBe("ok");
          expect(item.logs?.map((log) => log.message)).toContainEqual([
            "tails-basic-marker",
          ]);
          expect(item.event?.request?.url).toContain("/hello");
        }),
      { timeout: 60_000 },
    );

    it.effect(
      "drops events while the consumer is down and delivers once it starts",
      () =>
        Effect.gen(function* () {
          // The consumer is not running yet: starting the producer and serving
          // requests must both succeed — events are dropped with a warning.
          const producer = yield* startTestWorker(
            producerWorker(
              "tails-late-producer",
              "tails-late-consumer",
              "tails-late-marker",
            ),
          );
          expect(yield* producer.fetchText("/hello")).toBe(
            "hello from producer",
          );

          const consumer = yield* startTestWorker(
            consumerWorker("tails-late-consumer"),
          );
          yield* waitForRegistryEntry({
            kind: "worker",
            scriptName: "tails-late-consumer",
          });

          // The producer's registry proxy picks the consumer up asynchronously;
          // keep producing until an event lands.
          const events = yield* producer.fetch("/hello").pipe(
            Effect.andThen(
              consumer.fetchJson<Array<RecordedTraceItem>>("/events"),
            ),
            Effect.flatMap((items) =>
              items.length > 0
                ? Effect.succeed(items)
                : Effect.fail(new PredicateFailed({ value: items })),
            ),
            Effect.retry({
              while: (error) => error._tag === "PredicateFailed",
              schedule: Schedule.spaced("250 millis"),
              times: 120,
            }),
          );
          expect(events[0].logs?.map((log) => log.message)).toContainEqual([
            "tails-late-marker",
          ]);
        }),
      { timeout: 90_000 },
    );
  },
);

// A runtime composed without the registry proxy plugin (`tails` has nothing
// to resolve through) must fail fast with a typed `ConfigError` instead of
// silently starting a worker whose tail events go nowhere. This lives outside
// the `layer(localRuntimeLayer)` suite: `PluginContext.make` also picks
// plugins up from the ambient effect context, so the suite's registry proxy
// would leak into the deliberately registry-free runtime below.
describe("Tail workers without a registry proxy", () => {
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
    "fails with ConfigError when tails are declared without a registry proxy",
    () =>
      Effect.gen(function* () {
        const runtime = yield* Runtime.Runtime;
        const error = yield* runtime
          .start(producerWorker("tails-no-registry", "tails-nowhere", "unused"))
          .pipe(Effect.flip);
        expect(error._tag).toBe("ConfigError");
        expect(error.subtag).toBe("PluginNotFound");
      }).pipe(Effect.provide(noRegistryRuntimeLayer), Effect.scoped),
    { timeout: 30_000 },
  );
});
