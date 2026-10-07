import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
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
        readonly serverOs?: string;
        readonly serverArch?: string;
        readonly serverAppVersion?: string;
        readonly serverMode?: string;
        readonly t3CodeVersion?: string;
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
      readonly serverOs?: string;
      readonly serverArch?: string;
      readonly serverAppVersion?: string;
      readonly serverMode?: string;
      readonly t3CodeVersion?: string;
    };
  }>;
}

const SentBatch = Schema.fromJsonString(
  Schema.Struct({
    batch: Schema.Array(Schema.Struct({ uuid: Schema.String, event: Schema.String })),
  }),
);

const decodeSentBatch = Schema.decodeEffect(SentBatch);

/**
 * HTTP client that reads each batch, then fails as if the connection dropped
 * before the response arrived. PostHog stores these batches, so the server
 * must not send them forever.
 */
const layerAcceptThenFailClient = (batches: Array<ReadonlyArray<{ readonly uuid: string }>>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.body._tag === "Uint8Array") {
          const body = yield* decodeSentBatch(new TextDecoder().decode(request.body.body)).pipe(
            Effect.orDie,
          );
          batches.push(body.batch);
        }
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: "connection reset" }),
        });
      }),
    ),
  );

const layerToggleTest = (
  clientLayer: Layer.Layer<HttpClient.HttpClient>,
  telemetryEnabled = true,
  settingsLayer = ServerSettings.layerTest({ telemetryEnabled }),
) =>
  AnalyticsService.layer.pipe(
    Layer.provideMerge(settingsLayer),
    Layer.provide(
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-telemetry-toggle-" }),
    ),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: true,
          T3CODE_TELEMETRY_FLUSH_BATCH_SIZE: 20,
        }),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcessPlatform, "linux"),
        Layer.succeed(HostProcessArchitecture, "arm64"),
        clientLayer,
      ),
    ),
  );

it("retryDelayMs doubles from 2s and stays under the 5 minute cap", () => {
  assert.equal(AnalyticsService.retryDelayMs(1, 0), 1_000);
  assert.equal(AnalyticsService.retryDelayMs(2, 0.999_999), 4_000);
  assert.equal(AnalyticsService.retryDelayMs(30, 0), 150_000);
  assert.equal(AnalyticsService.retryDelayMs(30, 0.999_999), 300_000);
});

const layerTest = Layer.mergeAll(NodeServices.layer, ServerSettings.layerTest());

it.layer(layerTest)("AnalyticsService test", (it) => {
  it.effect("a batch that keeps failing is retried with backoff, then dropped", () =>
    Effect.gen(function* () {
      const batches: Array<ReadonlyArray<{ readonly uuid: string }>> = [];
      const layerRuntime = AnalyticsService.layer.pipe(
        Layer.provideMerge(
          ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-telemetry-retry-" }),
        ),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              T3CODE_TELEMETRY_ENABLED: true,
              T3CODE_POSTHOG_KEY: "phc_test_key",
              T3CODE_POSTHOG_HOST: "http://localhost",
            }),
          ),
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "win32"),
            Layer.succeed(HostProcessArchitecture, "x64"),
            layerAcceptThenFailClient(batches),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        for (let index = 0; index < 20; index += 1) {
          yield* analytics.record("test.retry", { index });
        }
        // Before the fix this loop sent the batch about once a second.
        for (let second = 0; second < 600; second += 1) {
          yield* TestClock.adjust("1 second");
        }
      }).pipe(Effect.provide(layerRuntime));

      assert.equal(batches.length, 5);
      const uuids = batches.map((batch) => batch.map((event) => event.uuid).join(","));
      assert.equal(new Set(uuids).size, 1, "every retry carries the same uuids");
      assert.equal(new Set(batches[0]?.map((event) => event.uuid)).size, 20);
    }),
  );

  it.effect("flush drains all buffered events across multiple batches", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const layerServerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-base-",
      });

      const layerTelemetry = AnalyticsService.layer.pipe(Layer.provideMerge(layerServerConfig));
      const layerConfig = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: true,
          T3CODE_POSTHOG_KEY: "phc_test_key",
          T3CODE_POSTHOG_HOST: "http://localhost",
          T3CODE_TELEMETRY_FLUSH_BATCH_SIZE: 20,
        }),
      );
      const layerBatchServer = HttpServer.serve(
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

          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const layerRuntime = layerTelemetry.pipe(
        Layer.provide(layerConfig),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "linux"),
            Layer.succeed(HostProcessArchitecture, "arm64"),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(layerBatchServer).pipe(Effect.forkScoped);
        const telemetryIdentifier = yield* getTelemetryIdentifier;
        assert.equal(telemetryIdentifier !== null, true);
        const analytics = yield* AnalyticsService.AnalyticsService;

        for (let index = 0; index < 45; index += 1) {
          yield* analytics.record("test.flush.drain", { index });
        }

        yield* analytics.flush;
      }).pipe(Effect.provide(layerRuntime));

      const batchRequests = capturedRequests.filter(
        (request): request is RecordedBatchRequest & { readonly body: RecordedBatchBody } =>
          Array.isArray(request.body?.batch),
      );
      assert.equal(batchRequests.length, 3);
      assert.equal(
        batchRequests.every(
          (request) => request.path.endsWith("/batch/") || request.path.endsWith("/batch"),
        ),
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
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every(
            (event) =>
              event.properties?.serverOs === "Linux" &&
              event.properties.serverArch === "arm64" &&
              event.properties.serverAppVersion === event.properties.t3CodeVersion &&
              event.properties.serverMode === "web",
          ),
        ),
        true,
      );
    }),
  );

  it.effect("does not send batch requests when telemetry is disabled", () =>
    Effect.gen(function* () {
      const capturedPaths: Array<string> = [];
      const layerServerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-disabled-",
      });
      const layerTelemetry = AnalyticsService.layer.pipe(Layer.provideMerge(layerServerConfig));
      const layerConfig = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: false,
          T3CODE_POSTHOG_KEY: "phc_test_key",
          T3CODE_POSTHOG_HOST: "http://localhost",
        }),
      );
      const layerBatchServer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          capturedPaths.push(request.url);
          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const layerRuntime = layerTelemetry.pipe(
        Layer.provide(layerConfig),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "linux"),
            Layer.succeed(HostProcessArchitecture, "arm64"),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(layerBatchServer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* analytics.record("test.disabled", { index: 1 });
        yield* analytics.flush;
        yield* settings.updateSettings({ telemetryEnabled: false });
        yield* settings.updateSettings({ telemetryEnabled: true });
        yield* analytics.record("test.environment-still-disabled");
        yield* analytics.flush;
      }).pipe(Effect.provide(layerRuntime));

      assert.deepEqual(capturedPaths, []);
    }),
  );

  it.effect("records and flushes without rereading settings after startup", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      let settingsReads = 0;
      let batchesSent = 0;
      const settingsLayer = Layer.succeed(ServerSettings.ServerSettingsService, {
        ...settings,
        getSettings: Effect.sync(() => settingsReads++).pipe(Effect.andThen(settings.getSettings)),
      });
      const clientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            batchesSent++;
            return HttpClientResponse.fromWeb(request, new Response("{}"));
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        assert.equal(settingsReads, 1);
        for (let index = 0; index < 25; index++) {
          yield* analytics.record("test.cached-gate", { index });
        }
        yield* analytics.flush;
        assert.equal(batchesSent, 2);
        yield* settings.updateSettings({ telemetryEnabled: false });
        yield* analytics.record("test.disabled");
        yield* analytics.flush;
        assert.equal(batchesSent, 2);
        yield* settings.updateSettings({ telemetryEnabled: true });
        yield* analytics.record("test.reenabled");
        yield* analytics.flush;
        assert.equal(batchesSent, 3);
        assert.equal(settingsReads, 1);
      }).pipe(Effect.provide(layerToggleTest(clientLayer, true, settingsLayer)));
    }),
  );

  it.effect("rapid opt-out and opt-in discard queued events and retries", () =>
    Effect.gen(function* () {
      const batches: Array<typeof SentBatch.Type.batch> = [];
      const layerRuntime = layerToggleTest(layerAcceptThenFailClient(batches), false);
      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* analytics.record("test.disabled-at-startup");
        yield* analytics.flush;
        assert.deepEqual(batches, []);
        yield* settings.updateSettings({ telemetryEnabled: true });
        yield* analytics.record("server.boot.heartbeat");
        yield* analytics.flush;
        assert.equal(batches.length, 1);
        yield* analytics.record("client.connected");
        yield* settings.updateSettings({ telemetryEnabled: false });
        yield* analytics.record("test.disabled");
        yield* settings.updateSettings({ telemetryEnabled: true });
        yield* analytics.flush;
        assert.equal(batches.length, 1, "opt-out discarded queued events and retries");
        yield* analytics.record("client.connected");
        yield* analytics.flush;
        assert.equal(batches.length, 2);
        assert.deepEqual(
          batches[1]?.map((event) => event.event),
          ["client.connected"],
        );
        assert.notEqual(batches[0]?.[0]?.uuid, batches[1]?.[0]?.uuid);
        // Prevent the shutdown flush from retrying the new failed batch.
        yield* settings.updateSettings({ telemetryEnabled: false });
      }).pipe(Effect.provide(layerRuntime));
    }),
  );

  it.effect.each(["successful", "failed"] as const)(
    "opt-out during a %s send discards pending batches",
    (firstRequestOutcome) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const batches: Array<typeof SentBatch.Type.batch> = [];

        const layerClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.gen(function* () {
              if (Predicate.isTagged(request.body, "Uint8Array")) {
                const body = yield* decodeSentBatch(
                  new TextDecoder().decode(request.body.body),
                ).pipe(Effect.orDie);

                batches.push(body.batch);
              }

              if (batches.length === 1) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);

                if (firstRequestOutcome === "failed") {
                  return yield* new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      cause: "connection reset",
                    }),
                  });
                }
              }

              return HttpClientResponse.fromWeb(request, new Response("{}"));
            }),
          ),
        );

        const layerRuntime = layerToggleTest(layerClient);
        yield* Effect.gen(function* () {
          const analytics = yield* AnalyticsService.AnalyticsService;
          const settings = yield* ServerSettings.ServerSettingsService;

          for (let index = 0; index < 21; index++) {
            yield* analytics.record("test.before-opt-out", { index });
          }

          const flushing = yield* analytics.flush.pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          yield* settings.updateSettings({ telemetryEnabled: false });
          yield* settings.updateSettings({ telemetryEnabled: true });
          yield* analytics.record("test.after-opt-in");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(flushing);
          assert.equal(batches.length, 1, "the old flush stops after its in-flight request");
          yield* analytics.flush;
          assert.equal(batches.length, 2);
          assert.deepEqual(
            batches[1]?.map((event) => event.event),
            ["test.after-opt-in"],
            "only the new event is sent without old retries",
          );
        }).pipe(Effect.provide(layerRuntime));
      }),
  );
});
