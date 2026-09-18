import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Telemetry from "@/Telemetry.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { WorkerProps } from "@/Cloudflare/Workers/Worker.ts";

/** KV namespace read by `/fanout` so each fiber emits a platform span. */
export const Store = Cloudflare.KV.Namespace("NativeTracingStore");

/** Queue whose consumer (below, same Worker) traces its handler. */
export const TracingQueue = Cloudflare.Queues.Queue("NativeTracingQueue");

/**
 * Durable Object whose RPC method opens Effect spans, so the
 * DurableObjectBridge's per-call telemetry build is covered.
 */
export class TracingTarget extends Cloudflare.DurableObject<TracingTarget>()(
  "TracingTarget",
  Effect.succeed(
    Effect.succeed({
      work: (requestId: string) =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan("request.id", requestId);
          yield* Effect.log("do-work").pipe(Effect.withSpan("do.inner"));
          return "do-ok";
        }).pipe(Effect.withSpan("do.operation")),
    }),
  ),
) {}

/** Sampled flag of the span the surrounding `withSpan` opened. */
const currentSampled = Effect.currentSpan.pipe(
  Effect.map((span) => span.sampled),
  Effect.orElseSucceed(() => undefined),
);

/**
 * Shared init Effect for native-tracing fixtures. `Cloudflare.Telemetry()`
 * enables Workers Traces and installs the per-event Tracer. Optional
 * `COLLECTOR_URL` adds logs-only OTLP so composition tests can put the
 * Cloudflare Tracer last without dropping logs; `HEAD_SAMPLING_RATE`
 * (default `1`) drives the sampling-cascade test.
 *
 * Routes (each `?id=` is annotated as `request.id` on the outer span so a
 * test can find its trace):
 * - `/work`   — one nested span with scalar and non-scalar attributes.
 * - `/fanout` — concurrent fibers + an explicit fork, each with a KV read
 *   (platform span) and a nested span.
 * - `/exits`  — a failing child span and an interrupted child span.
 * - `/rpc`    — a Durable Object RPC whose method opens spans.
 * - `/enqueue` — sends to the queue this Worker consumes; the consumer
 *   opens spans per message.
 * - `/sampled` — reports Effect's `sampled` flag for a span and its child.
 */
export const tracedWorkerImpl = Effect.gen(function* () {
  const kv = yield* Cloudflare.KV.ReadNamespace(yield* Store);
  const targets = yield* TracingTarget;
  const queueResource = yield* TracingQueue;
  const queue = yield* Cloudflare.Queues.WriteQueue(queueResource);

  yield* Cloudflare.Queues.consumeQueueMessages<{ id: string }>(
    queueResource,
    { batchSize: 1, maxRetries: 1, maxWaitTime: "500 millis" },
    (stream) =>
      Stream.runForEach(stream, (message) =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan("request.id", message.body.id);
          yield* Effect.log("queue-work").pipe(Effect.withSpan("queue.inner"));
        }).pipe(Effect.withSpan("queue.operation")),
      ),
  );

  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const url = new URL(request.url, "http://x");
      const requestId = url.searchParams.get("id") ?? url.pathname;
      const operation = <A, E, R>(body: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan("request.id", requestId);
          return yield* body;
        }).pipe(Effect.withSpan("operation"));

      if (url.pathname === "/fanout") {
        // Parent/sibling attribution under Effect's scheduler: two
        // concurrent fibers plus an explicit fork, each sleeping (so the
        // scheduler resumes them on fresh timer ticks, outside the async
        // context that opened `operation`), each doing a KV read (a
        // Cloudflare auto-instrumented span) and opening a nested span.
        // `?kv=0` skips the KV read (pure Effect spans only).
        const withKv = url.searchParams.get("kv") !== "0";
        const branch = (name: string) =>
          Effect.gen(function* () {
            yield* Effect.sleep("5 millis");
            if (withKv) {
              yield* kv.get(`${name}:${requestId}`).pipe(Effect.orDie);
            }
            yield* Effect.sleep("5 millis");
            yield* Effect.log(name).pipe(Effect.withSpan(`${name}.inner`));
          }).pipe(Effect.withSpan(name));
        yield* operation(
          Effect.gen(function* () {
            const forked = yield* Effect.forkChild(branch("forked"));
            yield* Effect.all([branch("child.a"), branch("child.b")], {
              concurrency: "unbounded",
            });
            yield* Fiber.join(forked);
          }),
        );
        return yield* HttpServerResponse.json({
          marker: "native-did-fanout",
          id: requestId,
        });
      }

      if (url.pathname === "/exits") {
        // `effect.exit` for the non-success cases: a child that fails
        // (caught by the parent, which therefore succeeds) and a child
        // that is interrupted while sleeping.
        yield* operation(
          Effect.gen(function* () {
            yield* Effect.fail(new Error("boom")).pipe(
              Effect.withSpan("failing.child"),
              Effect.ignore,
            );
            const sleeper = yield* Effect.forkChild(
              Effect.sleep("30 seconds").pipe(
                Effect.withSpan("interrupted.child"),
              ),
            );
            yield* Effect.sleep("10 millis");
            yield* Fiber.interrupt(sleeper);
          }),
        );
        return yield* HttpServerResponse.json({
          marker: "native-did-exits",
          id: requestId,
        });
      }

      if (url.pathname === "/rpc") {
        const result = yield* targets.getByName("tracing").work(requestId);
        return yield* HttpServerResponse.json({
          marker: `native-did-rpc:${result}`,
          id: requestId,
        });
      }

      if (url.pathname === "/enqueue") {
        yield* queue.send({ id: requestId }).pipe(Effect.orDie);
        return yield* HttpServerResponse.json({
          marker: "native-did-enqueue",
          id: requestId,
        });
      }

      if (url.pathname === "/sampled") {
        const sampled = yield* Effect.gen(function* () {
          const outer = yield* currentSampled;
          const child = yield* currentSampled.pipe(
            Effect.withSpan("sampled.child"),
          );
          return { operation: outer, child };
        }).pipe(Effect.withSpan("operation"));
        return yield* HttpServerResponse.json({
          marker: "native-did-sample",
          ...sampled,
        });
      }

      if (
        url.pathname === "/work" ||
        url.pathname === "/one" ||
        url.pathname === "/two"
      ) {
        const work = Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan("request.id", requestId);
          yield* Effect.annotateCurrentSpan("scalar.number", 42);
          yield* Effect.annotateCurrentSpan("scalar.boolean", true);
          yield* Effect.annotateCurrentSpan("unsupported", { nested: true });
          yield* Effect.log("native-tracing-log").pipe(
            Effect.withSpan("native.child"),
          );
          return yield* HttpServerResponse.json({
            marker: "native-did-work",
            path: requestId,
          });
        }).pipe(Effect.withSpan("operation"));
        return yield* work;
      }
      return HttpServerResponse.text("native-tracing-ok");
    }).pipe(Effect.orDie),
  };
}).pipe(
  Effect.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const collectorUrl = yield* Config.String("COLLECTOR_URL").pipe(
          Effect.orElseSucceed(() => undefined),
        );
        const composeOrder = yield* Config.String("COMPOSE_ORDER").pipe(
          Effect.orElseSucceed(() => "cf-last"),
        );
        const headSamplingRate = yield* Config.Number(
          "HEAD_SAMPLING_RATE",
        ).pipe(Effect.orElseSucceed(() => 1));
        const native = Layer.mergeAll(
          Cloudflare.Telemetry({ headSamplingRate, persist: true }),
          Cloudflare.KV.ReadNamespaceBinding,
          Cloudflare.Queues.WriteQueueBinding,
          Cloudflare.Queues.EventSourceLive,
        );
        if (collectorUrl === undefined) {
          return native;
        }
        const otlp = Telemetry.layerOtlp({
          logs: { url: `${collectorUrl.replace(/\/$/, "")}/v1/logs` },
          serviceName: "native-tracing-test",
        });
        // Both orders must keep OTLP logs after the Telemetry.layer
        // fromBoundConfig one-liner.
        return composeOrder === "otlp-last"
          ? Layer.mergeAll(native, otlp)
          : Layer.mergeAll(otlp, native);
      }),
    ),
  ),
);

/**
 * Construct an Effect-native traced Worker with extra test-site props
 * (streaming tails, experimental flags). `main` is this file.
 */
export const makeTracedWorker = (
  id: string,
  props: Partial<WorkerProps> = {},
) =>
  Cloudflare.Worker(
    id,
    {
      ...props,
      main: import.meta.url,
      compatibility: {
        date: props.compatibility?.date ?? "2026-08-25",
        flags: props.compatibility?.flags,
      },
    },
    tracedWorkerImpl,
  );

/**
 * Live-test Worker: traces enabled via the Layer, no Worker
 * `observability.traces` prop.
 */
export default class NativeTracingWorker extends Cloudflare.Worker<NativeTracingWorker>()(
  "NativeTracingWorker",
  {
    main: import.meta.url,
    compatibility: { date: "2026-08-25" },
  },
  tracedWorkerImpl,
) {}
