import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  startDelayedOtlpCollector,
  startOtlpCollector,
  type OtlpCollector,
} from "../Utils/OtlpCollector.ts";
import OtelEventFlushWorker from "./fixtures/otel-event-flush-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

/** The spans an OTLP/JSON trace export carries; other fields are stripped. */
const TraceExport = Schema.fromJsonString(
  Schema.Struct({
    resourceSpans: Schema.Array(
      Schema.Struct({
        scopeSpans: Schema.Array(
          Schema.Struct({
            spans: Schema.Array(
              Schema.Struct({
                traceId: Schema.String,
                spanId: Schema.String,
                parentSpanId: Schema.optional(Schema.String),
                name: Schema.String,
              }),
            ),
          }),
        ),
      }),
    ),
  }),
);

/**
 * The batches carrying the test's own spans, with those spans' names. Local
 * tools probe every port they see listening (T3 Code sends `GET /` to the
 * Worker), and the Worker exports those requests too. The test's spans are
 * its client trace, which the DO RPC events continue; anything else is a
 * probe's.
 */
const ownBatches = (batches: OtlpCollector["requests"], traceId: string) =>
  Effect.forEach(batches, (batch) =>
    Schema.decodeUnknownEffect(TraceExport)(batch.body).pipe(
      Effect.map(({ resourceSpans }) => {
        const records = resourceSpans
          .flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans))
          .filter((span) => span.traceId === traceId);
        return { batch, records, spans: records.map((span) => span.name) };
      }),
    ),
  ).pipe(Effect.map((decoded) => decoded.filter(({ spans }) => spans.length > 0)));

test.provider(
  "delivers Worker and Durable Object OTLP batches without delaying the Worker response",
  (stack) =>
    Effect.gen(function* () {
      // Hold only Worker exports: the DO may flush in either foreground or background.
      const collector = yield* startOtlpCollector({
        holdResponse: (body) => body.includes('"name":"otel-event-flush.worker"'),
      });
      const currentConfig = yield* ConfigProvider.ConfigProvider;
      yield* stack.destroy();
      const deployment = yield* stack
        .deploy(
          Effect.gen(function* () {
            const worker = yield* OtelEventFlushWorker;
            return { url: worker.url };
          }),
        )
        .pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.orElse(
              ConfigProvider.fromUnknown({
                OTLP_EVENT_FLUSH_URL: `${collector.url}/v1/traces`,
              }),
              currentConfig,
            ),
          ),
        );

      if (deployment.url === undefined) {
        return yield* Effect.die("OTLP event flush test Worker URL unavailable");
      }
      // The test's requests share one fresh trace, told apart from probes.
      const trace = yield* Effect.makeSpanScoped("telemetry-local.client", { root: true });
      const own = Effect.suspend(() => ownBatches(collector.requests, trace.traceId));
      const completed = own.pipe(
        Effect.map((batches) => batches.filter(({ batch }) => batch.completed).length),
      );
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(deployment.url).pipe(Effect.withParentSpan(trace));
      expect(response.status).toBe(200);
      expect(yield* response.text).toBe("worker-saw:durable-object-ok");

      // Release only after the response, not on a timer that can outlive
      // the exporter's shutdown deadline under runner load.
      expect(yield* completed).toBeLessThanOrEqual(1);
      yield* Effect.sync(collector.releaseResponses);

      // Both batches must be acknowledged before the next event.
      yield* completed.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("100 millis"),
          until: (count) => count >= 2,
          times: 30,
        }),
      );
      expect(yield* completed).toBe(2);

      // Same contract for the Durable Object RPC event path: the Worker's
      // own batch (the 4th) must not be complete at response time.
      yield* Effect.sync(collector.holdResponses);
      const rpcResponse = yield* client
        .get(`${deployment.url}/rpc`)
        .pipe(Effect.withParentSpan(trace));
      expect(rpcResponse.status).toBe(200);
      expect(yield* rpcResponse.text).toBe("worker-saw:durable-object-rpc-ok");
      expect(yield* completed).toBeLessThanOrEqual(3);
      yield* Effect.sync(collector.releaseResponses);

      yield* completed.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("100 millis"),
          until: (count) => count >= 4,
          times: 30,
        }),
      );
      const batches = yield* own;
      // The DO RPC event continues the caller's trace, parented on the
      // Worker span that made the call, as the DO fetch event does.
      const spans = batches.flatMap(({ records }) => records);
      const rpcSpan = spans.find((span) => span.name === "otel-event-flush.rpc");
      expect(rpcSpan?.traceId).toBe(trace.traceId);
      expect(spans.find((span) => span.spanId === rpcSpan?.parentSpanId)?.name).toBe(
        "otel-event-flush.worker",
      );
      expect(batches).toHaveLength(4);
      expect(batches.every(({ batch }) => batch.completed && !batch.aborted)).toBe(true);
      for (const [name, count] of [
        ["otel-event-flush.worker", 2],
        ["otel-event-flush.child", 1],
        ["otel-event-flush.rpc", 1],
        ["GET", 3],
      ] as const) {
        expect(batches.filter(({ spans }) => spans.includes(name))).toHaveLength(count);
      }

      yield* stack.destroy();
      expect(yield* completed).toBe(4);
    }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 120_000,
  },
);

for (const scenario of [
  { name: "bound default", shutdownTimeout: 0, delivered: true },
  { name: "custom 3 seconds", shutdownTimeout: 3_000, delivered: false },
  { name: "custom 10 seconds", shutdownTimeout: 10_000, delivered: true },
]) {
  test.provider(
    `DO RPC exporter deadline with a four-second acknowledgement (${scenario.name})`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const collector = yield* startDelayedOtlpCollector();
        const currentConfig = yield* ConfigProvider.ConfigProvider;
        const deployment = yield* stack
          .deploy(
            Effect.gen(function* () {
              const worker = yield* OtelEventFlushWorker;
              return { url: worker.url };
            }),
          )
          .pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.orElse(
                ConfigProvider.fromUnknown({
                  OTLP_EVENT_FLUSH_URL: `${collector.url}/v1/traces`,
                  OTLP_EVENT_FLUSH_SHUTDOWN_TIMEOUT: `${scenario.shutdownTimeout} millis`,
                }),
                currentConfig,
              ),
            ),
          );
        if (deployment.url === undefined) {
          return yield* Effect.fail(new Error("OTLP deadline Worker URL unavailable"));
        }
        const trace = yield* Effect.makeSpanScoped("telemetry-local.client", { root: true });
        const own = Effect.suspend(() => ownBatches(collector.requests, trace.traceId));
        const client = yield* HttpClient.HttpClient;
        const startedAt = yield* Effect.sync(() => Date.now());
        const responseFiber = yield* Effect.gen(function* () {
          const response = yield* client.get(`${deployment.url}/rpc`);
          const body = yield* response.text;
          const receivedAt = yield* Effect.sync(() => Date.now());
          return { status: response.status, body, receivedAt };
        }).pipe(Effect.withParentSpan(trace), Effect.forkChild());

        const rpcBatch = yield* own.pipe(
          Effect.map(
            (batches) => batches.find(({ spans }) => spans.includes("otel-event-flush.rpc"))?.batch,
          ),
          Effect.repeat({
            schedule: Schedule.spaced("500 millis"),
            until: (batch) => batch !== undefined,
            times: 10,
          }),
        );
        if (rpcBatch === undefined) {
          const response = yield* Fiber.join(responseFiber).pipe(Effect.timeout("10 seconds"));
          yield* Effect.logError("Missing DO RPC export", {
            scenario,
            response,
            batches: collector.requests,
          });
          return yield* Effect.fail(new Error("The collector never received the DO RPC batch"));
        }
        const response = yield* Fiber.join(responseFiber).pipe(Effect.timeout("10 seconds"));
        expect(response.status).toBe(200);
        expect(response.body).toBe("worker-saw:durable-object-rpc-ok");
        yield* own.pipe(
          Effect.map(
            (batches) =>
              batches.length === 2 && batches.every(({ batch }) => batch.closedAt !== undefined),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (settled) => settled,
            times: 10,
          }),
        );
        const batches = yield* own;
        yield* Effect.log("Native DO RPC exporter deadline", {
          scenario: scenario.name,
          workerResponseMillis: response.receivedAt - startedAt,
          workerResponseAfterRpcReceiptMillis: response.receivedAt - rpcBatch.receivedAt,
          rpcSocketLifetimeMillis:
            rpcBatch.closedAt === undefined ? undefined : rpcBatch.closedAt - rpcBatch.receivedAt,
          batches: batches.map(({ batch, spans }) => ({
            spans,
            receivedAt: batch.receivedAt,
            responseStartedAt: batch.responseStartedAt,
            closedAt: batch.closedAt,
            completed: batch.completed,
            aborted: batch.aborted,
          })),
        });
        expect(batches).toHaveLength(2);
        const names = batches.flatMap(({ spans }) => spans).sort();
        expect(names).toEqual(["GET", "otel-event-flush.rpc", "otel-event-flush.worker"]);
        expect(rpcBatch.closedAt).toBeTypeOf("number");
        expect(response.receivedAt).toBeLessThan(rpcBatch.closedAt!);
        expect(rpcBatch.completed).toBe(scenario.delivered);
        expect(rpcBatch.aborted).toBe(!scenario.delivered);
        expect(batches.filter(({ batch }) => batch.completed)).toHaveLength(
          scenario.delivered ? 2 : 1,
        );
        const socketLifetime = rpcBatch.closedAt! - rpcBatch.receivedAt;
        if (scenario.delivered) {
          expect(rpcBatch.responseStartedAt).toBeTypeOf("number");
          expect(response.receivedAt).toBeLessThan(rpcBatch.responseStartedAt!);
          expect(socketLifetime).toBeGreaterThanOrEqual(3_900);
          expect(socketLifetime).toBeLessThan(10_000);
        } else {
          expect(rpcBatch.responseStartedAt).toBeUndefined();
          expect(socketLifetime).toBeGreaterThanOrEqual(2_500);
          expect(socketLifetime).toBeLessThan(4_000);
        }
        const workerBatch = batches.find(({ batch }) => batch !== rpcBatch)!.batch;
        expect(workerBatch.completed).toBe(true);
        expect(workerBatch.aborted).toBe(false);
        yield* stack.destroy();
      }).pipe(Effect.scoped),
    {
      tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
      timeout: 120_000,
    },
  );
}
