import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import OtelEventFlushWorker from "./fixtures/otel-event-flush-worker.ts";
import {
  startDelayedOtlpCollector,
  startOtlpCollector,
} from "../Utils/OtlpCollector.ts";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const traceSpanNames = (body: string) => {
  const payload = JSON.parse(body) as {
    resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[];
  };
  return payload.resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) =>
      scope.spans.map((span) => span.name),
    ),
  );
};

test.provider(
  "delivers Worker and Durable Object OTLP batches without delaying the Worker response",
  (stack) =>
    Effect.gen(function* () {
      // Hold only Worker exports: the DO may flush in either foreground or background.
      const collector = yield* startOtlpCollector({
        holdResponse: (body) =>
          body.includes('"name":"otel-event-flush.worker"'),
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
        return yield* Effect.die(
          "OTLP event flush test Worker URL unavailable",
        );
      }
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(deployment.url);
      expect(response.status).toBe(200);
      expect(yield* response.text).toBe("worker-saw:durable-object-ok");

      // Release only after the response, not on a timer that can outlive
      // the exporter's shutdown deadline under runner load.
      expect(collector.completedRequests.value).toBeLessThanOrEqual(1);
      yield* Effect.sync(collector.releaseResponses);

      // Both batches must be acknowledged before the next event.
      yield* Effect.sync(() => collector.completedRequests.value).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("100 millis"),
          until: (completed) => completed >= 2,
          times: 30,
        }),
      );
      expect(collector.completedRequests.value).toBe(2);

      // Same contract for the Durable Object RPC event path: the Worker's
      // own batch (the 4th) must not be complete at response time.
      yield* Effect.sync(collector.holdResponses);
      const rpcResponse = yield* client.get(`${deployment.url}/rpc`);
      expect(rpcResponse.status).toBe(200);
      expect(yield* rpcResponse.text).toBe("worker-saw:durable-object-rpc-ok");
      expect(collector.completedRequests.value).toBeLessThanOrEqual(3);
      yield* Effect.sync(collector.releaseResponses);

      yield* Effect.sync(() => collector.completedRequests.value).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("100 millis"),
          until: (completed) => completed >= 4,
          times: 30,
        }),
      );
      expect(collector.completedRequests.value).toBe(4);
      expect(collector.requests).toHaveLength(4);
      expect(
        collector.requests.every((batch) => batch.completed && !batch.aborted),
      ).toBe(true);
      for (const [name, count] of [
        ["otel-event-flush.worker", 2],
        ["otel-event-flush.child", 1],
        ["otel-event-flush.rpc", 1],
        ["http.server GET", 3],
      ] as const) {
        expect(
          collector.requests.filter((batch) =>
            batch.body.includes(`"name":"${name}"`),
          ),
        ).toHaveLength(count);
      }

      yield* stack.destroy();
      expect(collector.completedRequests.value).toBe(4);
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
          return yield* Effect.fail(
            new Error("OTLP deadline Worker URL unavailable"),
          );
        }
        const client = yield* HttpClient.HttpClient;
        const startedAt = yield* Effect.sync(() => Date.now());
        const responseFiber = yield* Effect.gen(function* () {
          const response = yield* client.get(`${deployment.url}/rpc`);
          const body = yield* response.text;
          const receivedAt = yield* Effect.sync(() => Date.now());
          return { status: response.status, body, receivedAt };
        }).pipe(Effect.forkChild());

        const rpcBatch = yield* Effect.sync(() =>
          collector.requests.find((batch) =>
            traceSpanNames(batch.body).includes("otel-event-flush.rpc"),
          ),
        ).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("500 millis"),
            until: (batch) => batch !== undefined,
            times: 10,
          }),
        );
        if (rpcBatch === undefined) {
          const response = yield* Fiber.join(responseFiber).pipe(
            Effect.timeout("10 seconds"),
          );
          yield* Effect.logError("Missing DO RPC export", {
            scenario,
            response,
            batches: collector.requests,
          });
          return yield* Effect.fail(
            new Error("The collector never received the DO RPC batch"),
          );
        }
        const response = yield* Fiber.join(responseFiber).pipe(
          Effect.timeout("10 seconds"),
        );
        expect(response.status).toBe(200);
        expect(response.body).toBe("worker-saw:durable-object-rpc-ok");
        yield* Effect.sync(
          () =>
            collector.requests.length === 2 &&
            collector.requests.every((batch) => batch.closedAt !== undefined),
        ).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (settled) => settled,
            times: 10,
          }),
        );
        yield* Effect.log("Native DO RPC exporter deadline", {
          scenario: scenario.name,
          workerResponseMillis: response.receivedAt - startedAt,
          workerResponseAfterRpcReceiptMillis:
            response.receivedAt - rpcBatch.receivedAt,
          rpcSocketLifetimeMillis:
            rpcBatch.closedAt === undefined
              ? undefined
              : rpcBatch.closedAt - rpcBatch.receivedAt,
          batches: collector.requests.map((batch) => ({
            spans: traceSpanNames(batch.body),
            receivedAt: batch.receivedAt,
            responseStartedAt: batch.responseStartedAt,
            closedAt: batch.closedAt,
            completed: batch.completed,
            aborted: batch.aborted,
          })),
        });
        expect(collector.requests).toHaveLength(2);
        const names = yield* Effect.sync(() =>
          collector.requests
            .flatMap((batch) => traceSpanNames(batch.body))
            .sort(),
        );
        expect(names).toEqual([
          "http.server GET",
          "otel-event-flush.rpc",
          "otel-event-flush.worker",
        ]);
        expect(rpcBatch.closedAt).toBeTypeOf("number");
        expect(response.receivedAt).toBeLessThan(rpcBatch.closedAt!);
        expect(rpcBatch.completed).toBe(scenario.delivered);
        expect(rpcBatch.aborted).toBe(!scenario.delivered);
        expect(collector.completedRequests.value).toBe(
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
        const workerBatch = collector.requests.find(
          (batch) => batch !== rpcBatch,
        )!;
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
