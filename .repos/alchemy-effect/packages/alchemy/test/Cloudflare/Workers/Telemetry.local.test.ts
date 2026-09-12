import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { createServer, type Server } from "node:http";
import { expect } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import OtelEventFlushWorker from "./fixtures/otel-event-flush-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

interface DelayedOtlpCollector {
  readonly server: Server;
  readonly url: string;
  readonly completedRequests: { value: number };
}

/**
 * Starts a local OTLP endpoint that only counts responses fully written to the
 * client. The Node server is a test adapter for observing workerd cancellation.
 */
const startDelayedOtlpCollector = Effect.acquireRelease(
  Effect.callback<DelayedOtlpCollector, Error>((resume) => {
    const completedRequests = { value: 0 };
    const server = createServer((request, response) => {
      request.resume();
      request.once("end", () => {
        setTimeout(() => {
          response.once("finish", () => {
            completedRequests.value += 1;
          });
          response.writeHead(200, { "content-type": "application/json" });
          response.end('{"partialSuccess":{}}');
        }, 500);
      });
    });
    const onError = (error: Error) => resume(Effect.fail(error));
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        resume(
          Effect.fail(new Error("OTLP test collector address unavailable")),
        );
        return;
      }
      resume(
        Effect.succeed({
          server,
          completedRequests,
          url: `http://127.0.0.1:${address.port}/v1/traces`,
        }),
      );
    });
    return Effect.sync(() => server.close());
  }),
  ({ server }) =>
    Effect.callback<void, Error>((resume) => {
      server.close((error) =>
        resume(error === undefined ? Effect.void : Effect.fail(error)),
      );
    }).pipe(Effect.orDie),
);

test.provider(
  "delivers Worker and Durable Object OTLP batches without delaying the Worker response",
  (stack) =>
    Effect.gen(function* () {
      const collector = yield* startDelayedOtlpCollector;
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
                OTLP_EVENT_FLUSH_URL: collector.url,
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

      // The latency contract: the Worker's own batch must still be in
      // flight at response time — its export completes in the background
      // under `ctx.waitUntil`, so the 500ms-delayed collector cannot have
      // acknowledged it yet. A value of 2 here means the Worker response
      // waited on its own telemetry export — a latency regression. (The DO
      // batch may or may not have completed, depending on whether the DO
      // bridge exports foreground or background — both satisfy the
      // contract.)
      const completedAtResponse = collector.completedRequests.value;
      expect(completedAtResponse).toBeLessThanOrEqual(1);

      // The delivery contract: with workerd still alive, background
      // exports must complete — nothing is lost.
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
      const rpcResponse = yield* client.get(`${deployment.url}/rpc`);
      expect(rpcResponse.status).toBe(200);
      expect(yield* rpcResponse.text).toBe("worker-saw:durable-object-rpc-ok");
      expect(collector.completedRequests.value).toBeLessThanOrEqual(3);

      yield* Effect.sync(() => collector.completedRequests.value).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("100 millis"),
          until: (completed) => completed >= 4,
          times: 30,
        }),
      );
      expect(collector.completedRequests.value).toBe(4);

      yield* stack.destroy();
      expect(collector.completedRequests.value).toBe(4);
    }),
  { timeout: 120_000 },
);
