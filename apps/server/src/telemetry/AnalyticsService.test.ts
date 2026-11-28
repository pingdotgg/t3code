import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";

import type { ManagedPolicyDocument, ServerSettingsError } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
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
        readonly wsl?: string;
        readonly serverWslDistro?: string;
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
      readonly wsl?: string;
      readonly serverWslDistro?: string;
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
          serverOs: Schema.optionalKey(Schema.String),
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

const analyticsLayerWith = (
  client: HttpClient.HttpClient,
  policy?: ManagedPolicyDocument,
  telemetry: { readonly enabled: boolean | undefined } = { enabled: true },
) =>
  AnalyticsService.layer.pipe(
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-telemetry-retry-" }),
    ),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ...(telemetry.enabled === undefined
            ? {}
            : { T3CODE_TELEMETRY_ENABLED: telemetry.enabled }),
          T3CODE_TELEMETRY_KEY: "phc_test_key",
          T3CODE_TELEMETRY_HOST: "http://localhost",
        }),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcess.Platform, "win32"),
        Layer.succeed(HostProcess.Architecture, "x64"),
        Layer.succeed(HttpClient.HttpClient, client),
        ManagedPolicy.layerTest(policy),
      ),
    ),
  );

/**
 * Runs `record` (20 events by default), then lets `minutes` of background
 * flushes run against a client that answers every send with `respond`.
 * Returns the sent batches.
 */
const sendFor = (
  minutes: number,
  respond: Respond,
  record: Effect.Effect<
    void,
    ServerSettingsError | PlatformError.PlatformError,
    | AnalyticsService.AnalyticsService
    | ServerSettings.ServerSettingsService
    | Effect.Services<typeof getTelemetryIdentity>
  > = recordTwentyEvents,
  policy?: ManagedPolicyDocument,
  telemetry: { readonly enabled: boolean | undefined } = { enabled: true },
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
    const runtimeLayer = analyticsLayerWith(client, policy, telemetry);

    yield* Effect.gen(function* () {
      yield* record;
      for (let second = 0; second < minutes * 60; second += 1) {
        yield* TestClock.adjust("1 second");
      }
    }).pipe(Effect.provide(runtimeLayer));
    return batches;
  });

const layerTestDependencies = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  ServerSettings.layerTest(),
);

it.layer(layerTestDependencies)("AnalyticsService test", (it) => {
  it.effect.each([
    { saved: true, environment: undefined, expected: true },
    { saved: false, environment: undefined, expected: false },
    { saved: false, environment: true, expected: true },
    { saved: true, environment: false, expected: false },
  ])(
    "uses saved=$saved and environment=$environment for usage data",
    ({ saved, environment, expected }) =>
      Effect.gen(function* () {
        const batches = yield* sendFor(
          0,
          respondWithStatus(204),
          Effect.gen(function* () {
            const analytics = yield* AnalyticsService.AnalyticsService;
            const settings = yield* ServerSettings.ServerSettingsService;
            const config = yield* ServerConfig.ServerConfig;
            const fs = yield* FileSystem.FileSystem;
            assert.equal(yield* analytics.record("test.preference"), expected);
            assert.equal(yield* fs.exists(config.anonymousIdPath), expected);
            yield* settings.updateSettings({ shareUsageData: !saved });
            yield* settings.updateSettings({ shareUsageData: saved });
            yield* analytics.flush;
          }),
          undefined,
          { enabled: environment },
        ).pipe(Effect.provide(ServerSettings.layerTest({ shareUsageData: saved })));
        assert.equal(batches.flat().length, expected ? (environment === undefined ? 0 : 1) : 0);
      }),
  );

  it.effect("opt-out immediately discards queued events and retries", () =>
    Effect.gen(function* () {
      let fail = true;
      const batches = yield* sendFor(
        0,
        (request) => respondWithStatus(fail ? 503 : 204)(request),
        Effect.gen(function* () {
          const analytics = yield* AnalyticsService.AnalyticsService;
          const settings = yield* ServerSettings.ServerSettingsService;
          const owner = [{ source: "device", ownerId: "a".repeat(64) }] as const;
          const queuedOwner = [{ source: "connect", ownerId: "b".repeat(64) }] as const;
          yield* analytics.recordOwners(owner, "client");
          yield* analytics.flush;
          yield* analytics.recordOwners(queuedOwner, "client");
          yield* analytics.record("test.queued");
          yield* settings.updateSettings({ shareUsageData: false });
          assert.isFalse(yield* analytics.record("test.disabled"));
          yield* settings.updateSettings({ shareUsageData: true });
          fail = false;
          yield* analytics.recordOwners([...owner, ...queuedOwner], "client");
          yield* analytics.record("test.after-enable");
          yield* analytics.flush;
        }),
        undefined,
        { enabled: undefined },
      );
      assert.deepEqual(
        batches.map((batch) => batch.map((event) => event.event)),
        [
          ["install.owner_observed"],
          ["install.owner_observed", "install.owner_observed", "test.after-enable"],
        ],
      );
      assert.deepEqual(
        batches[1]?.map((event) => event.properties.ownerSource),
        ["device", "connect", undefined],
      );
    }),
  );

  it.effect.each([204, 503])(
    "opt-out during an in-flight %s response invalidates the old flush",
    (status) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let requests = 0;
        const batches = yield* sendFor(
          0,
          (request) =>
            Effect.gen(function* () {
              if (++requests === 1) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                return yield* respondWithStatus(status)(request);
              }
              return yield* respondWithStatus(204)(request);
            }),
          Effect.gen(function* () {
            const analytics = yield* AnalyticsService.AnalyticsService;
            const settings = yield* ServerSettings.ServerSettingsService;
            const owner = [{ source: "device", ownerId: "a".repeat(64) }] as const;
            yield* analytics.recordOwners(owner, "client");
            yield* recordTwentyEvents;
            yield* analytics.record("test.old-pending-batch");
            const flushing = yield* analytics.flush.pipe(Effect.forkChild);
            yield* Deferred.await(started);
            yield* settings.updateSettings({ shareUsageData: false });
            yield* settings.updateSettings({ shareUsageData: true });
            yield* analytics.recordOwners(owner, "client");
            yield* analytics.record("test.after-enable");
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(flushing);
            assert.equal(requests, 1);
            yield* analytics.flush;
          }),
          undefined,
          { enabled: undefined },
        );
        assert.equal(batches.length, 2);
        assert.deepEqual(
          batches[1]?.map((event) => event.event),
          status === 204 ? ["test.after-enable"] : ["install.owner_observed", "test.after-enable"],
        );
      }),
  );

  it.effect("an opt-out during UUID generation cannot enqueue an old recording", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const crypto = yield* SecureRandom.SecureRandom;
      function uuidV7(options?: { readonly format?: "string" | undefined }): Effect.Effect<string>;
      function uuidV7<Format extends "string" | "bytes">(options: {
        readonly format: Format;
      }): Effect.Effect<Format extends "bytes" ? Uint8Array : string>;
      function uuidV7(options?: {
        readonly format?: "string" | "bytes" | undefined;
      }): Effect.Effect<string | Uint8Array> {
        const generated: Effect.Effect<string | Uint8Array> =
          options?.format === "bytes" ? crypto.uuidV7({ format: "bytes" }) : crypto.uuidV7();
        return Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(generated),
        );
      }
      const layerCrypto = Layer.succeed(SecureRandom.SecureRandom, { ...crypto, uuidV7 });
      const batches = yield* sendFor(
        0,
        respondWithStatus(204),
        Effect.gen(function* () {
          const analytics = yield* AnalyticsService.AnalyticsService;
          const settings = yield* ServerSettings.ServerSettingsService;
          const recording = yield* analytics.record("test.in-progress").pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* settings.updateSettings({ shareUsageData: false });
          yield* settings.updateSettings({ shareUsageData: true });
          yield* Deferred.succeed(release, undefined);
          assert.isFalse(yield* Fiber.join(recording));
          yield* analytics.record("test.new");
          yield* analytics.flush;
        }),
        undefined,
        { enabled: undefined },
      ).pipe(Effect.provide(layerCrypto));
      assert.deepEqual(
        batches.flat().map((event) => event.event),
        ["test.new"],
      );
    }),
  );

  it.effect("an old owner recording cannot release a fresh queue's reservation", () =>
    Effect.gen(function* () {
      const oldStarted = yield* Deferred.make<void>();
      const freshStarted = yield* Deferred.make<void>();
      const duplicateStarted = yield* Deferred.make<void>();
      const releaseOld = yield* Deferred.make<void>();
      const releaseFresh = yield* Deferred.make<void>();
      const crypto = yield* SecureRandom.SecureRandom;
      let uuidCalls = 0;
      function uuidV7(options?: { readonly format?: "string" | undefined }): Effect.Effect<string>;
      function uuidV7<Format extends "string" | "bytes">(options: {
        readonly format: Format;
      }): Effect.Effect<Format extends "bytes" ? Uint8Array : string>;
      function uuidV7(options?: {
        readonly format?: "string" | "bytes" | undefined;
      }): Effect.Effect<string | Uint8Array> {
        const call = ++uuidCalls;
        const started = call === 1 ? oldStarted : call === 2 ? freshStarted : duplicateStarted;
        const release = call === 1 ? releaseOld : releaseFresh;
        const generated: Effect.Effect<string | Uint8Array> =
          options?.format === "bytes" ? crypto.uuidV7({ format: "bytes" }) : crypto.uuidV7();
        return Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(generated),
        );
      }
      const batches = yield* sendFor(
        0,
        respondWithStatus(204),
        Effect.gen(function* () {
          const analytics = yield* AnalyticsService.AnalyticsService;
          const settings = yield* ServerSettings.ServerSettingsService;
          const owner = [{ source: "device", ownerId: "a".repeat(64) }] as const;
          const old = yield* analytics.recordOwners(owner, "client").pipe(Effect.forkChild);
          yield* Deferred.await(oldStarted);
          yield* settings.updateSettings({ shareUsageData: false });
          yield* settings.updateSettings({ shareUsageData: true });
          const fresh = yield* analytics.recordOwners(owner, "client").pipe(Effect.forkChild);
          assert.equal(
            yield* Effect.raceFirst(
              Deferred.await(freshStarted).pipe(Effect.as("started")),
              Fiber.await(fresh).pipe(Effect.as("finished")),
            ),
            "started",
          );
          yield* Deferred.succeed(releaseOld, undefined);
          yield* Fiber.join(old);
          const duplicate = yield* analytics.recordOwners(owner, "client").pipe(Effect.forkChild);
          assert.equal(
            yield* Effect.raceFirst(
              Deferred.await(duplicateStarted).pipe(Effect.as("started")),
              Fiber.await(duplicate).pipe(Effect.as("finished")),
            ),
            "finished",
          );
          yield* Deferred.succeed(releaseFresh, undefined);
          yield* Fiber.join(fresh);
          yield* Fiber.join(duplicate);
          yield* analytics.flush;
          yield* analytics.recordOwners(owner, "client");
          yield* analytics.flush;
        }),
        undefined,
        { enabled: undefined },
      ).pipe(Effect.provideService(SecureRandom.SecureRandom, { ...crypto, uuidV7 }));
      assert.deepEqual(
        batches.flat().map((event) => event.event),
        ["install.owner_observed"],
      );
    }),
  );

  it.effect("recovers identity after failure while retaining a successful identity", () =>
    Effect.gen(function* () {
      const batches = yield* sendFor(
        0,
        respondWithStatus(204),
        Effect.gen(function* () {
          const analytics = yield* AnalyticsService.AnalyticsService;
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(config.anonymousIdPath, { recursive: true });
          assert.isFalse(yield* analytics.record("test.identity-failed"));
          yield* fs.remove(config.anonymousIdPath, { recursive: true });
          assert.isFalse(yield* analytics.record("test.identity-cooldown"));
          yield* TestClock.adjust("10 seconds");
          assert.isTrue(yield* analytics.record("test.identity-recovered"));
          yield* fs.remove(config.anonymousIdPath);
          yield* fs.makeDirectory(config.anonymousIdPath);
          yield* TestClock.adjust("1 minute");
          assert.isTrue(yield* analytics.record("test.identity-cached"));
          yield* analytics.flush;
        }),
      );
      const events = batches.flat();
      assert.deepEqual(
        events.map((event) => event.event),
        ["test.identity-recovered", "test.identity-cached"],
      );
      assert.equal(new Set(events.map((event) => event.distinct_id)).size, 1);
    }),
  );

  it.effect("waits for desktop shell consent and honors a late telemetry opt-out", () =>
    Effect.gen(function* () {
      for (const ci of [false, true]) {
        const env: NodeJS.ProcessEnv = {
          T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1",
          ...(ci ? { CI: "true" } : {}),
        };
        const batches = yield* sendFor(
          0,
          respondWithStatus(204),
          Effect.gen(function* () {
            const analytics = yield* AnalyticsService.AnalyticsService;
            const settings = yield* ServerSettings.ServerSettingsService;
            yield* analytics.record("test.before-discovery");
            yield* analytics.flush;
            env.T3CODE_TELEMETRY_ENABLED = "false";
            delete env.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING;
            yield* analytics.record("test.opted-out");
            yield* analytics.flush;
            yield* settings.updateSettings({ shareUsageData: false });
            env.T3CODE_TELEMETRY_ENABLED = "true";
            yield* analytics.record("test.allowed");
            yield* analytics.flush;
            delete env.T3CODE_TELEMETRY_ENABLED;
            yield* analytics.record("test.launch-override");
            yield* settings.updateSettings({ shareUsageData: true });
            yield* analytics.flush;
          }),
          undefined,
          { enabled: ci ? undefined : true },
        ).pipe(Effect.provideService(HostProcess.Environment, env));
        assert.deepEqual(
          batches.flat().map((event) => event.event),
          ci ? ["test.allowed"] : ["test.allowed", "test.launch-override"],
        );
      }
    }),
  );

  it.effect("sends nothing while DO_NOT_TRACK is set", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { DO_NOT_TRACK: "1" };
      const batches = yield* sendFor(
        0,
        respondWithStatus(204),
        Effect.gen(function* () {
          const analytics = yield* AnalyticsService.AnalyticsService;
          assert.isFalse(yield* analytics.record("test.do-not-track"));
          yield* analytics.flush;
          env.DO_NOT_TRACK = "0";
          yield* analytics.record("test.queued-before-do-not-track");
          env.DO_NOT_TRACK = "1";
          yield* analytics.flush;
          env.DO_NOT_TRACK = "0";
          yield* analytics.record("test.allowed");
          yield* analytics.flush;
        }),
      ).pipe(Effect.provideService(HostProcess.Environment, env));
      assert.deepEqual(
        batches.flat().map((event) => event.event),
        ["test.allowed"],
      );
    }),
  );

  it.effect("sends an anonymous event under its own id and without the install id", () =>
    Effect.gen(function* () {
      const batches = yield* sendFor(
        0,
        respondWithStatus(204),
        Effect.gen(function* () {
          const analytics = yield* AnalyticsService.AnalyticsService;
          yield* analytics.record("test.linked");
          yield* analytics.record("test.anonymous", {}, { anonymous: true });
          yield* analytics.flush;
        }),
      );
      assert.equal(batches.length, 2);
      const [linked, anonymous] = batches.map(([event]) => event);

      assert.isDefined(linked?.properties.installId);
      assert.isDefined(linked?.properties.serverOs);
      assert.equal(anonymous?.distinct_id, anonymous?.uuid);
      assert.notEqual(anonymous?.distinct_id, linked?.distinct_id);
      assert.isUndefined(anonymous?.properties.installId);
      assert.isUndefined(anonymous?.properties.serverOs);
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

  it.effect(
    "sends nothing when a managed policy turns telemetry off, despite the environment",
    () =>
      Effect.gen(function* () {
        const policy = { schemaVersion: 1, organization: "Example Corp" } as const;
        const allowed = yield* sendFor(1, respondWithStatus(204), recordTwentyEvents, {
          ...policy,
          limits: { telemetry: true },
        });
        assert.equal(allowed.length, 1);
        const denied = yield* sendFor(1, respondWithStatus(204), recordTwentyEvents, {
          ...policy,
          limits: { telemetry: false },
        });
        assert.deepEqual(denied, []);
      }),
  );

  it.effect("sends nothing on a CI runner unless the environment opts in", () =>
    Effect.gen(function* () {
      const onCi = (telemetry: Parameters<typeof analyticsLayerWith>[2], shareUsageData: boolean) =>
        sendFor(1, respondWithStatus(204), recordTwentyEvents, undefined, telemetry).pipe(
          Effect.provide(ServerSettings.layerTest({ shareUsageData })),
          Effect.provideService(HostProcess.Environment, { GITHUB_ACTIONS: "true" }),
        );
      for (const saved of [true, false]) {
        assert.deepEqual(yield* onCi({ enabled: undefined }, saved), []);
        assert.equal((yield* onCi({ enabled: true }, saved)).length, 1);
      }
    }),
  );

  it.effect("drops a batch the endpoint rejects without sending it again", () =>
    Effect.gen(function* () {
      const batches = yield* sendFor(10, respondWithStatus(400));
      assert.equal(batches.length, 1);
    }),
  );

  it.effect("shutdown stops waiting for a telemetry endpoint that never answers", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        analyticsLayerWith(HttpClient.make(() => Effect.never)),
        scope,
      );
      yield* recordTwentyEvents.pipe(Effect.provide(context));

      const shutdown = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(shutdown);
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
          T3CODE_TELEMETRY_KEY: "phc_test_key",
          T3CODE_TELEMETRY_HOST: "http://localhost",
          T3CODE_TELEMETRY_FLUSH_BATCH_SIZE: 20,
          // A name its user chose; only the family may leave the machine.
          WSL_DISTRO_NAME: "Acme-Client-Secret-Ubuntu",
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
            ManagedPolicy.layerTest(),
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
              event.properties.serverMode === "web" &&
              event.properties.wsl === "other" &&
              event.properties.serverWslDistro === "other",
          ),
        ),
        true,
      );
      assert.equal(JSON.stringify(batchRequests).includes("Acme-Client-Secret-Ubuntu"), false);
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
          T3CODE_TELEMETRY_KEY: "phc_test_key",
          T3CODE_TELEMETRY_HOST: "http://localhost",
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
            ManagedPolicy.layerTest(),
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

it("reports a WSL distro by its family, never by a name its user chose", () => {
  assert.equal(AnalyticsService.wslDistroFamily("Ubuntu-24.04"), "Ubuntu");
  assert.equal(AnalyticsService.wslDistroFamily("openSUSE-Tumbleweed"), "openSUSE");
  assert.equal(AnalyticsService.wslDistroFamily("Acme-Client-Secret-Ubuntu"), "other");
  assert.equal(AnalyticsService.wslDistroFamily("  "), undefined);
});
