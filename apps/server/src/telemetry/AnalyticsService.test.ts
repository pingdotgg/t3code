import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ServerSettingsError } from "@t3tools/contracts";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { getTelemetryIdentity } from "./Identify.ts";
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
    batch: Schema.Array(
      Schema.Struct({
        uuid: Schema.String,
        event: Schema.String,
        distinct_id: Schema.String,
        properties: Schema.Struct({
          telemetryChannel: Schema.String,
          installId: Schema.optionalKey(Schema.String),
          ownerSource: Schema.optionalKey(Schema.String),
          observedBy: Schema.optionalKey(Schema.String),
        }),
      }),
    ),
  }),
);
const decodeSentBatch = Schema.decodeEffect(SentBatch);
type SentEvent = (typeof SentBatch.Type)["batch"][number];
type Respond = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

const respondWithStatus =
  (status: number): Respond =>
  (request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })));

/**
 * Answers 503 for `minutes` after the first send, then 204. `answers` holds each
 * answer with its time in ms after the first send (the test clock runs on across tests).
 */
const failingFor = (minutes: number) => {
  const answers: Array<{ readonly at: number; readonly status: number }> = [];
  let firstSend: number | undefined;
  const respond: Respond = (request) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => {
      firstSend ??= now;
      const at = now - firstSend;
      const status = at < minutes * 60_000 ? 503 : 204;
      answers.push({ at, status });
      return respondWithStatus(status)(request);
    });
  return { respond, answers };
};

const recordTwentyEvents = Effect.gen(function* () {
  const analytics = yield* AnalyticsService.AnalyticsService;
  for (let index = 0; index < 20; index += 1) {
    yield* analytics.record("test.retry", { index });
  }
});

/**
 * Runs `record` (20 events by default), then lets `minutes` of background
 * flushes run against a client that answers every send with `respond`.
 * Returns the sent batches.
 */
const sendFor = <E = never>(
  minutes: number,
  respond: Respond,
  record: Effect.Effect<
    void,
    E,
    | AnalyticsService.AnalyticsService
    | ServerSettings.ServerSettingsService
    | Effect.Services<typeof getTelemetryIdentity>
  > = recordTwentyEvents,
  telemetryEnabled = true,
  settingsLayer = ServerSettings.layerTest({ telemetryEnabled }),
) =>
  Effect.gen(function* () {
    const batches: Array<ReadonlyArray<SentEvent>> = [];
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.body._tag === "Uint8Array") {
          const body = yield* decodeSentBatch(new TextDecoder().decode(request.body.body)).pipe(
            Effect.orDie,
          );
          batches.push(body.batch);
        }
        return yield* respond(request);
      }),
    );
    const runtimeLayer = AnalyticsService.layer.pipe(
      Layer.provideMerge(settingsLayer),
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
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Architecture, "x64"),
          Layer.succeed(HttpClient.HttpClient, client),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      yield* record;
      for (let second = 0; second < minutes * 60; second += 1) {
        yield* TestClock.adjust("1 second");
      }
    }).pipe(Effect.provide(runtimeLayer));
    return batches;
  });

it.layer(NodeServices.layer)("AnalyticsService test", (it) => {
  it.effect("does not read analytics identity or collect events when opted out", () =>
    Effect.gen(function* () {
      const batches = yield* sendFor(
        0,
        respondWithStatus(204),
        Effect.gen(function* () {
          const analytics = yield* AnalyticsService.AnalyticsService;
          const settings = yield* ServerSettings.ServerSettingsService;
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          assert.isFalse(yield* fs.exists(config.anonymousIdPath));
          yield* analytics.record("before-consent");
          yield* analytics.recordOwners([{ source: "device", ownerId: "a".repeat(64) }], "client");
          yield* analytics.flush;
          assert.isFalse(yield* fs.exists(config.anonymousIdPath));
          yield* settings.updateSettings({ telemetryEnabled: true });
          yield* analytics.record("after-consent");
          yield* analytics.recordOwners([{ source: "device", ownerId: "a".repeat(64) }], "client");
          yield* analytics.flush;
        }),
        false,
      );
      assert.deepEqual(
        batches.flatMap((batch) => batch.map((event) => event.event)),
        ["after-consent", "install.owner_observed"],
      );
    }),
  );

  it.effect.each([false, true])(
    "disabling analytics drops old events and retains new ones with delayed notifications: %s",
    (delayNotifications) =>
      Effect.gen(function* () {
        let attempts = 0;
        const batches = yield* sendFor(
          0,
          (request) => respondWithStatus(++attempts === 1 ? 503 : 204)(request),
          Effect.gen(function* () {
            const analytics = yield* AnalyticsService.AnalyticsService;
            const settings = yield* ServerSettings.ServerSettingsService;
            yield* analytics.record("failed-before-opt-out");
            yield* analytics.flush;
            yield* analytics.record("queued-before-opt-out");
            yield* settings.updateSettings({ telemetryEnabled: false });
            yield* analytics.record("while-disabled");
            yield* analytics.flush;
            assert.equal(attempts, 1);
            yield* settings.updateSettings({ telemetryEnabled: true });
            yield* analytics.record("queued-before-second-opt-out");
            yield* settings.updateSettings({ telemetryEnabled: false });
            yield* settings.updateSettings({ telemetryEnabled: true });
            yield* analytics.record("after-opt-in");
            yield* analytics.flush;
          }),
          true,
          delayNotifications
            ? Layer.effect(
                ServerSettings.ServerSettingsService,
                Effect.map(ServerSettings.ServerSettingsService, (settings) => ({
                  ...settings,
                  subscribeChanges: Effect.succeed(Stream.never),
                })),
              ).pipe(Layer.provide(ServerSettings.layerTest()))
            : ServerSettings.layerTest(),
        );
        assert.deepEqual(
          batches.flatMap((batch) => batch.map((event) => event.event)),
          ["failed-before-opt-out", "after-opt-in"],
        );
      }),
  );
  it.effect.each([{ status: 204 }, { status: 503 }])(
    "discards old batches after off/on during an in-flight $status response",
    ({ status }) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let attempts = 0;
        const batches = yield* sendFor(
          0,
          (request) =>
            Effect.gen(function* () {
              if (attempts++ === 0) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                return yield* respondWithStatus(status)(request);
              }
              return yield* respondWithStatus(204)(request);
            }),
          Effect.gen(function* () {
            const analytics = yield* AnalyticsService.AnalyticsService;
            const settings = yield* ServerSettings.ServerSettingsService;
            for (let index = 0; index < 21; index += 1) {
              yield* analytics.record(`before-opt-out-${index}`);
            }
            const flushing = yield* analytics.flush.pipe(Effect.forkChild);
            yield* Deferred.await(started);
            yield* settings.updateSettings({ telemetryEnabled: false });
            yield* settings.updateSettings({ telemetryEnabled: true });
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(flushing);
            yield* analytics.record("after-opt-in");
            yield* analytics.flush;
          }),
        );
        assert.deepEqual(
          batches.flatMap((batch) => batch.map((event) => event.event)),
          [...Array.from({ length: 20 }, (_, index) => `before-opt-out-${index}`), "after-opt-in"],
        );
      }),
  );

  it.effect.each([
    { operation: "flush", snapshotFailure: false },
    { operation: "flush", snapshotFailure: true },
    { operation: "record", snapshotFailure: true },
  ])(
    "preserves new events after a stale $operation consent result (failure: $snapshotFailure)",
    ({ operation, snapshotFailure }) =>
      Effect.gen(function* () {
        const checked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const pauseNextSnapshot = yield* Ref.make(false);
        const settingsLayer = Layer.effect(
          ServerSettings.ServerSettingsService,
          Effect.map(ServerSettings.ServerSettingsService, (settings) => {
            const service: ServerSettings.ServerSettingsService["Service"] = {
              ...settings,
              withSettingsSnapshot: (use) =>
                Ref.getAndSet(pauseNextSnapshot, false).pipe(
                  Effect.flatMap((pause) => {
                    if (!pause) return settings.withSettingsSnapshot(use);
                    const snapshot = snapshotFailure
                      ? settings.withSettingsSnapshot(() =>
                          Effect.fail(
                            new ServerSettingsError({
                              settingsPath: "test settings",
                              operation: "read-file",
                              cause: "unavailable",
                            }),
                          ),
                        )
                      : settings.withSettingsSnapshot(use);
                    const resume = Deferred.succeed(checked, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    );
                    return snapshot.pipe(
                      Effect.tap(() => resume),
                      Effect.tapError(() => resume),
                    );
                  }),
                ),
            };
            return service;
          }),
        ).pipe(Layer.provide(ServerSettings.layerTest({ telemetryEnabled: false })));
        const batches = yield* sendFor(
          0,
          respondWithStatus(204),
          Effect.gen(function* () {
            const analytics = yield* AnalyticsService.AnalyticsService;
            const settings = yield* ServerSettings.ServerSettingsService;
            yield* Ref.set(pauseNextSnapshot, true);
            const pending = yield* (
              operation === "flush" ? analytics.flush : analytics.record("unavailable-consent")
            ).pipe(Effect.forkChild);
            yield* Deferred.await(checked);
            yield* settings.updateSettings({ telemetryEnabled: true });
            yield* analytics.record("after-opt-in");
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(pending);
            yield* analytics.flush;
          }),
          false,
          settingsLayer,
        );
        assert.deepEqual(
          batches.flat().map((event) => event.event),
          ["after-opt-in"],
        );
      }),
  );

  it.effect(
    "starts HTTP under the consent guard and releases it before waiting for a response",
    () =>
      Effect.gen(function* () {
        const checked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const checks = yield* Ref.make(0);
        let optedOut = false;
        const admittedWhileEnabled: boolean[] = [];
        const settingsLayer = Layer.effect(
          ServerSettings.ServerSettingsService,
          Effect.map(ServerSettings.ServerSettingsService, (settings) => {
            const service: ServerSettings.ServerSettingsService["Service"] = {
              ...settings,
              withSettingsSnapshot: (use) =>
                settings.withSettingsSnapshot(use).pipe(
                  Effect.tap(() =>
                    Effect.gen(function* () {
                      if ((yield* Ref.updateAndGet(checks, (count) => count + 1)) === 2) {
                        yield* Deferred.succeed(checked, undefined);
                        yield* Deferred.await(release);
                      }
                    }),
                  ),
                ),
            };
            return service;
          }),
        ).pipe(Layer.provide(ServerSettings.layerTest()));
        yield* sendFor(
          0,
          (request) =>
            Effect.gen(function* () {
              admittedWhileEnabled.push(!optedOut);
              yield* Deferred.await(release);
              return yield* respondWithStatus(204)(request);
            }),
          Effect.gen(function* () {
            const analytics = yield* AnalyticsService.AnalyticsService;
            const settings = yield* ServerSettings.ServerSettingsService;
            yield* analytics.record("before-opt-out");
            yield* Ref.set(checks, 0);
            const flushing = yield* analytics.flush.pipe(Effect.forkChild);
            yield* Deferred.await(checked);
            yield* settings.updateSettings({ telemetryEnabled: false });
            optedOut = true;
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(flushing);
          }),
          true,
          settingsLayer,
        );
        assert.deepEqual(admittedWhileEnabled, [true]);
      }),
  );

  it.effect("client owner reports cannot use up the server's owner cap", () =>
    Effect.gen(function* () {
      const batches = yield* sendFor(
        10,
        respondWithStatus(204),
        Effect.gen(function* () {
          const analytics = yield* AnalyticsService.AnalyticsService;
          yield* analytics.recordOwners(
            Array.from({ length: 1_001 }, (_, index) => ({
              source: "device" as const,
              ownerId: index.toString(16).padStart(64, "0"),
            })),
            "client",
          );
          // The event buffer also holds 1,000, so send the client events first.
          yield* analytics.flush;
          yield* analytics.recordOwners([{ source: "connect", ownerId: "a".repeat(64) }], "server");
        }),
      );
      const owners = batches.flat().map((event) => event.properties.observedBy);

      assert.equal(owners.filter((observedBy) => observedBy === "client").length, 1_000);
      assert.equal(owners.filter((observedBy) => observedBy === "server").length, 1);
    }),
  );

  it.effect("keeps a failed batch through a 20-minute outage and sends it once after", () =>
    Effect.gen(function* () {
      const ingest = failingFor(20);
      const batches = yield* sendFor(40, ingest.respond);
      const statuses = ingest.answers.map(({ status }) => status);
      assert.equal(statuses.at(-1), 204);
      assert.equal(statuses.filter((status) => status === 204).length, 1);
      const sentUuids = new Set(batches.map((batch) => batch.map(({ uuid }) => uuid).join()));
      assert.equal(sentUuids.size, 1);
      assert.equal(batches[0]?.length, 20);
    }),
  );

  it.effect("drops a batch that keeps failing for 30 minutes", () =>
    Effect.gen(function* () {
      const ingest = failingFor(Infinity);
      yield* sendFor(60, ingest.respond);
      const lastSend = ingest.answers.at(-1)?.at ?? 0;
      assert.isAtLeast(lastSend, 30 * 60_000);
      assert.isBelow(lastSend, 36 * 60_000);
    }),
  );

  it.effect("drops a batch the endpoint rejects without sending it again", () =>
    Effect.gen(function* () {
      const batches = yield* sendFor(10, respondWithStatus(400));
      assert.equal(batches.length, 1);
    }),
  );

  it.effect("flush drains all buffered events across multiple batches", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const layerServerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-base-",
      });

      const layerTelemetry = AnalyticsService.layer.pipe(
        Layer.provideMerge(layerServerConfig),
        Layer.provide(ServerSettings.layerTest({ telemetryEnabled: true })),
      );
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
            Layer.succeed(HostProcess.Platform, "linux"),
            Layer.succeed(HostProcess.Architecture, "arm64"),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(layerBatchServer).pipe(Effect.forkScoped);
        const { distinctId } = yield* getTelemetryIdentity;
        assert.equal(distinctId !== null, true);
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
      const layerTelemetry = AnalyticsService.layer.pipe(
        Layer.provideMerge(layerServerConfig),
        Layer.provide(ServerSettings.layerTest({ telemetryEnabled: true })),
      );
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
            Layer.succeed(HostProcess.Platform, "linux"),
            Layer.succeed(HostProcess.Architecture, "arm64"),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(layerBatchServer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.disabled", { index: 1 });
        yield* analytics.flush;
      }).pipe(Effect.provide(layerRuntime));

      assert.deepEqual(capturedPaths, []);
    }),
  );
});
