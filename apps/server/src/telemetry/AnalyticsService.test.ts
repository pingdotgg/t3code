import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import * as ServerConfig from "../config.ts";
import { getTelemetryIdentifier } from "./Identify.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

interface RecordedBatchRequest {
  readonly path: string;
  readonly body: {
    readonly batch?: ReadonlyArray<{
      readonly event?: string;
      readonly properties?: {
        readonly index?: number;
        readonly clientType?: string;
      };
    }>;
  } | null;
}

interface RecordedBatchBody {
  readonly batch: ReadonlyArray<{
    readonly event?: string;
    readonly properties?: {
      readonly index?: number;
      readonly clientType?: string;
    };
  }>;
}

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const isAnalyticsBatchDeliveryError = Schema.is(AnalyticsService.AnalyticsBatchDeliveryError);

it.layer(NodeServices.layer)("AnalyticsService test", (it) => {
  it.effect("flush drains buffered events and retries failed batches with structured context", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const capturedLogs: CapturedLog[] = [];
      let rejectNextBatch = false;
      const logger = Logger.make(({ fiber, message }) => {
        capturedLogs.push({
          message,
          annotations: fiber.getRef(References.CurrentLogAnnotations),
        });
      });
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-base-",
      });

      const telemetryLayer = AnalyticsService.layer.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: true,
          T3CODE_POSTHOG_KEY: "phc_test_key",
          T3CODE_POSTHOG_HOST: "",
          T3CODE_TELEMETRY_FLUSH_BATCH_SIZE: 20,
        }),
      );
      const batchServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "POST") {
            return HttpServerResponse.empty({ status: 404 });
          }

          const payload = yield* request.json.pipe(
            Effect.map((body) => body as RecordedBatchRequest["body"]),
            Effect.orElseSucceed(() => null),
          );

          capturedRequests.push({ path: request.url, body: payload });

          if (rejectNextBatch) {
            rejectNextBatch = false;
            return HttpServerResponse.empty({ status: 503 });
          }

          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const runtimeLayer = Layer.merge(
        telemetryLayer.pipe(
          Layer.provide(configLayer),
          Layer.provideMerge(NodeHttpServer.layerTest),
        ),
        Logger.layer([logger], { mergeWithExisting: false }),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const telemetryIdentifier = yield* getTelemetryIdentifier;
        assert.equal(telemetryIdentifier !== null, true);
        const analytics = yield* AnalyticsService.AnalyticsService;

        for (let index = 0; index < 45; index += 1) {
          yield* analytics.record("test.flush.drain", { index });
        }

        yield* analytics.flush;
        yield* analytics.record("test.flush.retry", { index: 45 });
        rejectNextBatch = true;
        yield* analytics.flush;
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      const batchRequests = capturedRequests
        .slice(0, 3)
        .filter((request): request is RecordedBatchRequest & { readonly body: RecordedBatchBody } =>
          Array.isArray(request.body?.batch),
        );
      assert.equal(batchRequests.length, 3);
      assert.equal(
        batchRequests.every((request) => request.path === "/batch/" || request.path === "/batch"),
        true,
      );
      const deliveredIndexes = batchRequests.flatMap((request) =>
        request.body.batch
          .filter((event) => event.event === "test.flush.drain")
          .map((event) => event.properties?.index)
          .filter((index): index is number => typeof index === "number"),
      );

      const sorted = deliveredIndexes.toSorted((a, b) => a - b);
      assert.equal(sorted.length, 45);
      assert.deepEqual(
        sorted,
        Array.from({ length: 45 }, (_, index) => index),
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every((event) => event.properties?.clientType === "cli-web-client"),
        ),
        true,
      );

      const retryRequests = capturedRequests.slice(3);
      assert.equal(retryRequests.length, 2);
      assert.deepEqual(retryRequests[0]?.body, retryRequests[1]?.body);

      const deliveryLog = capturedLogs.find((log) =>
        isAnalyticsBatchDeliveryError(log.annotations.cause),
      );
      assert.isDefined(deliveryLog);
      assert.equal(
        deliveryLog?.message,
        "Failed to deliver 1 analytics event to PostHog (endpoint input length 7).",
      );
      assert.equal("endpoint" in deliveryLog.annotations, false);
      assert.equal(deliveryLog.annotations.endpointInputLength, 7);

      const error = deliveryLog?.annotations.cause;
      assert.instanceOf(error, AnalyticsService.AnalyticsBatchDeliveryError);
      if (isAnalyticsBatchDeliveryError(error)) {
        assert.equal(error.endpointInputLength, 7);
        assert.equal(error.endpointProtocol, undefined);
        assert.equal(error.endpointHostname, undefined);
        assert.equal(error.eventCount, 1);
        assert.instanceOf(error.cause, HttpClientError.HttpClientError);
        if (error.cause instanceof HttpClientError.HttpClientError) {
          assert.equal(error.cause.reason._tag, "StatusCodeError");
          assert.equal(error.cause.response?.status, 503);
        }
      }
    }),
  );
});

it("keeps configured PostHog endpoint secrets out of direct error and log context", () => {
  const endpoint =
    "https://user:password@posthog.example.test/private/project?api_key=secret#fragment";
  const cause = new Error("delivery failed");
  const error = AnalyticsService.AnalyticsBatchDeliveryError.fromEndpoint({
    endpoint,
    eventCount: 2,
    cause,
  });

  assert.equal(error.endpointInputLength, endpoint.length);
  assert.equal(error.endpointProtocol, "https:");
  assert.equal(error.endpointHostname, "posthog.example.test");
  assert.equal(error.cause, cause);
  assert.equal("endpoint" in error, false);
  assert.equal(/user|password|private|project|api_key|secret|fragment/.test(error.message), false);
});
