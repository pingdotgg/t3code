import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as OtlpLogger from "effect/unstable/observability/OtlpLogger";
import * as OtlpMetrics from "effect/unstable/observability/OtlpMetrics";
import * as OtlpSerialization from "effect/unstable/observability/OtlpSerialization";
import * as OtlpTracer from "effect/unstable/observability/OtlpTracer";

import { RelayApi } from "@t3tools/contracts/relay";

import {
  RelayHttpPlatformLayer,
  clientApi,
  dpopClientApi,
  healthApi,
  metadataApi,
  mobileApi,
  relayClientAuthLayer,
  relayDpopClientAuthLayer,
  relayCors,
  relayEnvironmentAuthLayer,
  serverApi,
  traceRelayHttpRequest,
  tokenApi,
} from "./api.ts";
import { CloudMintKeyPair } from "./infra/CloudMintKeyPair.ts";
import {
  MANAGED_ENDPOINT_ZONE,
  managedEndpointBaseDomain,
  managedEndpointProvisionerTokenPolicies,
  relayPublicOrigin,
} from "./infra/ManagedEndpointStackConfig.ts";
import { ImportedCloudflareZone } from "./infra/ImportedCloudflareZone.ts";
import {
  RELAY_OBSERVABILITY_EXPORT_INTERVAL,
  RELAY_OBSERVABILITY_SERVICE_NAME,
  provisionRelayObservability,
} from "./infra/RelayObservability.ts";
import { recordRelayProductStateMetrics } from "./observability/ProductMetrics.ts";
import * as DeliveryAttempts from "./persistence/DeliveryAttempts.ts";
import * as AgentActivityRows from "./persistence/AgentActivityRows.ts";
import * as Devices from "./persistence/Devices.ts";
import * as DpopProofs from "./persistence/DpopProofs.ts";
import * as EnvironmentCredentials from "./persistence/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./persistence/EnvironmentLinks.ts";
import * as LiveActivities from "./persistence/LiveActivities.ts";
import { RelayDb, RelayHyperdrive } from "./db.ts";
import { RelayApnsDeliveryDeadLetterQueue, RelayApnsDeliveryQueue } from "./queues.ts";
import * as Settings from "./settings.ts";
import * as AgentActivityPublisher from "./services/AgentActivityPublisher.ts";
import * as ApnsDeliveryQueue from "./services/ApnsDeliveryQueue.ts";
import * as ApnsDeliveries from "./services/ApnsDeliveries.ts";
import * as EnvironmentConnector from "./services/EnvironmentConnector.ts";
import * as EnvironmentLinker from "./services/EnvironmentLinker.ts";
import * as EnvironmentPublishSignatures from "./services/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointProvider from "./services/ManagedEndpointProvider.ts";
import * as MobileRegistrations from "./services/MobileRegistrations.ts";
import * as RelayCrypto from "./RelayCrypto.ts";

const relayApiLayer = Layer.mergeAll(
  healthApi,
  metadataApi,
  mobileApi,
  clientApi,
  tokenApi,
  dpopClientApi,
  serverApi,
);

const makeAxiomHeaders = (input: {
  readonly token: Redacted.Redacted<string>;
  readonly dataset: string;
  readonly datasetHeader?: "X-Axiom-Dataset" | "X-Axiom-Metrics-Dataset";
}) => ({
  Authorization: `Bearer ${Redacted.value(input.token)}`,
  [input.datasetHeader ?? "X-Axiom-Dataset"]: input.dataset,
});

const makeRelayTelemetryLayer = (input: {
  readonly logsEndpoint: string;
  readonly tracesEndpoint: string;
  readonly metricsEndpoint: string;
  readonly eventsDatasetName: string;
  readonly metricsDatasetName: string;
  readonly ingestToken: Redacted.Redacted<string>;
}) => {
  const resource = {
    serviceName: RELAY_OBSERVABILITY_SERVICE_NAME,
    attributes: {
      "service.runtime": "cloudflare-worker",
      "service.component": "relay",
    },
  };

  return Layer.mergeAll(
    OtlpTracer.layer({
      url: input.tracesEndpoint,
      resource,
      headers: makeAxiomHeaders({
        token: input.ingestToken,
        dataset: input.eventsDatasetName,
      }),
      exportInterval: RELAY_OBSERVABILITY_EXPORT_INTERVAL,
    }),
    OtlpMetrics.layer({
      url: input.metricsEndpoint,
      resource,
      headers: makeAxiomHeaders({
        token: input.ingestToken,
        dataset: input.metricsDatasetName,
        datasetHeader: "X-Axiom-Metrics-Dataset",
      }),
      exportInterval: RELAY_OBSERVABILITY_EXPORT_INTERVAL,
    }),
    OtlpLogger.layer({
      url: input.logsEndpoint,
      resource,
      headers: makeAxiomHeaders({
        token: input.ingestToken,
        dataset: input.eventsDatasetName,
      }),
      exportInterval: RELAY_OBSERVABILITY_EXPORT_INTERVAL,
      mergeWithExisting: true,
    }),
  ).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer));
};

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.filename,
    compatibility: {
      date: "2026-05-22",
      flags: ["nodejs_compat"],
    },
    observability: {
      enabled: true,
      logs: {
        enabled: true,
        invocationLogs: true,
        persist: true,
      },
      traces: {
        enabled: true,
        headSamplingRate: 1,
        persist: true,
      },
    },
  },
  Effect.gen(function* () {
    const managedEndpointZone = yield* ImportedCloudflareZone("ManagedEndpointZone", {
      zoneId: MANAGED_ENDPOINT_ZONE.zoneId,
      baseSubdomain: MANAGED_ENDPOINT_ZONE.baseSubdomain,
    });
    const managedEndpointProvisionerToken = yield* Cloudflare.AccountApiToken(
      "ManagedEndpointProvisionerToken",
      {
        name: "t3-code-relay-managed-endpoint-provisioner",
        policies: Output.all(managedEndpointZone.accountId, managedEndpointZone.zoneId).pipe(
          Output.map(([accountId, zoneId]) =>
            managedEndpointProvisionerTokenPolicies({ accountId, zoneId }),
          ),
        ),
      },
    );
    const relayIssuer = yield* Alchemy.Variable(
      "RELAY_ISSUER",
      Output.map(managedEndpointZone.name, (name) => relayPublicOrigin({ name })) as never,
    );
    const managedEndpointBaseDomainValue = yield* Alchemy.Variable(
      "MANAGED_ENDPOINT_BASE_DOMAIN",
      Output.map(managedEndpointZone.name, (name) =>
        managedEndpointBaseDomain({
          name,
          baseSubdomain: MANAGED_ENDPOINT_ZONE.baseSubdomain,
        }),
      ) as never,
    );
    const managedEndpointCloudflareAccountId = yield* Alchemy.Secret(
      "MANAGED_ENDPOINT_CLOUDFLARE_ACCOUNT_ID",
      managedEndpointZone.accountId as never,
    );
    const managedEndpointCloudflareZoneId = yield* Alchemy.Secret(
      "MANAGED_ENDPOINT_CLOUDFLARE_ZONE_ID",
      managedEndpointZone.zoneId as never,
    );
    const managedEndpointCloudflareApiToken = yield* Alchemy.Secret(
      "MANAGED_ENDPOINT_CLOUDFLARE_API_TOKEN",
      managedEndpointProvisionerToken.value as never,
    );
    const relayHyperdrive = yield* RelayHyperdrive;
    const apnsDeliveryQueue = yield* RelayApnsDeliveryQueue;
    const apnsDeliveryDeadLetterQueue = yield* RelayApnsDeliveryDeadLetterQueue;
    const hyperdrive = yield* Cloudflare.Hyperdrive.bind(relayHyperdrive);
    const apnsDeliveryQueueSender = yield* Cloudflare.QueueBinding.bind(apnsDeliveryQueue);
    const cloudMintKeyPair = yield* CloudMintKeyPair("CloudMintKeyPair");
    const environment = yield* Alchemy.Variable(
      "APNS_ENVIRONMENT",
      Config.schema(Settings.ApnsEnvironment, "APNS_ENVIRONMENT").pipe(
        Config.withDefault("sandbox"),
      ),
    );
    const apnsTeamId = yield* Alchemy.Secret("APNS_TEAM_ID");
    const apnsKeyId = yield* Alchemy.Secret("APNS_KEY_ID");
    const apnsBundleId = yield* Alchemy.Secret("APNS_BUNDLE_ID");
    const apnsPrivateKey = yield* Alchemy.Secret("APNS_PRIVATE_KEY");
    const relayObservability = yield* provisionRelayObservability;
    const axiomIngestToken = yield* Alchemy.Secret(
      "AXIOM_INGEST_TOKEN",
      relayObservability.ingestToken.token as any,
    );
    const axiomLogsEndpoint = yield* Alchemy.Variable(
      "AXIOM_OTEL_LOGS_ENDPOINT",
      relayObservability.events.otelLogsEndpoint as never,
    );
    const axiomTracesEndpoint = yield* Alchemy.Variable(
      "AXIOM_OTEL_TRACES_ENDPOINT",
      relayObservability.events.otelTracesEndpoint as never,
    );
    const axiomMetricsEndpoint = yield* Alchemy.Variable(
      "AXIOM_OTEL_METRICS_ENDPOINT",
      relayObservability.metrics.otelMetricsEndpoint as never,
    );
    const axiomEventsDatasetName = yield* Alchemy.Variable(
      "AXIOM_EVENTS_DATASET",
      relayObservability.events.name as never,
    );
    const axiomMetricsDatasetName = yield* Alchemy.Variable(
      "AXIOM_METRICS_DATASET",
      relayObservability.metrics.name as never,
    );
    const relayTelemetryLayer = Layer.unwrap(
      Effect.gen(function* () {
        return makeRelayTelemetryLayer({
          logsEndpoint: yield* axiomLogsEndpoint,
          tracesEndpoint: yield* axiomTracesEndpoint,
          metricsEndpoint: yield* axiomMetricsEndpoint,
          eventsDatasetName: yield* axiomEventsDatasetName,
          metricsDatasetName: yield* axiomMetricsDatasetName,
          ingestToken: yield* axiomIngestToken,
        });
      }),
    );
    const randomApnsDeliveryJobSigningSecret = yield* Alchemy.Random(
      "ApnsDeliveryJobSigningSecret",
      { bytes: 32 },
    );
    const apnsDeliveryJobSigningSecret = yield* Alchemy.Secret(
      "APNS_DELIVERY_JOB_SIGNING_SECRET",
      randomApnsDeliveryJobSigningSecret.text as any,
    );
    const clerkSecretKey = yield* Alchemy.Secret("CLERK_SECRET_KEY");
    const cloudMintPrivateKey = yield* Alchemy.Secret(
      "CLOUD_MINT_PRIVATE_KEY",
      cloudMintKeyPair.privateKey as never,
    );
    const cloudMintPublicKey = yield* Alchemy.Secret(
      "CLOUD_MINT_PUBLIC_KEY",
      cloudMintKeyPair.publicKey as never,
    );
    const db = yield* Drizzle.postgres(hyperdrive.connectionString);

    const loadSettings = Effect.fn("relay.worker.settings")(function* () {
      const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const settings = Settings.Settings.of({
        relayIssuer: yield* relayIssuer,
        apns: {
          environment: yield* environment,
          teamId: yield* apnsTeamId,
          keyId: yield* apnsKeyId,
          bundleId: yield* apnsBundleId,
          privateKey: yield* apnsPrivateKey,
        },
        apnsDeliveryJobSigningSecret: yield* apnsDeliveryJobSigningSecret,
        clerkSecretKey: yield* clerkSecretKey,
        cloudMintPrivateKey: yield* cloudMintPrivateKey,
        cloudMintPublicKey: yield* cloudMintPublicKey,
        managedEndpointBaseDomain: yield* managedEndpointBaseDomainValue,
        cloudflareAccountId: yield* managedEndpointCloudflareAccountId,
        cloudflareZoneId: yield* managedEndpointCloudflareZoneId,
        cloudflareApiToken: yield* managedEndpointCloudflareApiToken,
      });
      const completedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      yield* Effect.logInfo("relay worker settings loaded", {
        durationMs: completedAt - startedAt,
      });
      return settings;
    });
    const getSettings = yield* Effect.cached(loadSettings());

    const makeRuntimeLayer = (settings: Settings.SettingsShape) =>
      Layer.mergeAll(
        MobileRegistrations.layer.pipe(Layer.provideMerge(AgentActivityPublisher.layer)),
        EnvironmentConnector.layer,
        EnvironmentLinker.layer.pipe(
          Layer.provideMerge(ManagedEndpointProvider.layer),
          Layer.provideMerge(DpopProofs.layer),
        ),
        EnvironmentPublishSignatures.layer.pipe(Layer.provideMerge(DpopProofs.layer)),
        DpopProofs.layer,
        relayTelemetryLayer,
      ).pipe(
        Layer.provide(ApnsDeliveries.layer),
        Layer.provide(ApnsDeliveryQueue.layer),
        Layer.provide(AgentActivityRows.layer),
        Layer.provide(Devices.layer),
        Layer.provide(EnvironmentCredentials.layer),
        Layer.provide(EnvironmentLinks.layer),
        Layer.provide(LiveActivities.layer),
        Layer.provide(DeliveryAttempts.layer),
        Layer.provide(Layer.succeed(RelayDb, db)),
        Layer.provide(
          Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {
            send: (body) =>
              apnsDeliveryQueueSender
                .send(body)
                .pipe(
                  Effect.mapError(
                    (cause) => new ApnsDeliveryQueue.ApnsDeliveryQueueSendError({ cause }),
                  ),
                ) as Effect.Effect<void, ApnsDeliveryQueue.ApnsDeliveryQueueSendError>,
          }),
        ),
        Layer.provide(Layer.succeed(Settings.Settings, settings)),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(RelayCrypto.layer),
      );

    const makeAppLayer = (settings: Settings.SettingsShape) => {
      const runtimeLayer = makeRuntimeLayer(settings);
      return relayApiLayer.pipe(
        Layer.provide(runtimeLayer),
        Layer.provide(relayClientAuthLayer),
        Layer.provide(relayDpopClientAuthLayer),
        Layer.provide(relayEnvironmentAuthLayer),
        Layer.provide(EnvironmentCredentials.layer),
        Layer.provide(EnvironmentLinks.layer),
        Layer.provide(Layer.succeed(RelayDb, db)),
        Layer.provide(Layer.succeed(Settings.Settings, settings)),
        Layer.provide(RelayCrypto.layer),
      );
    };

    yield* Cloudflare.messages<unknown>(apnsDeliveryQueue, {
      batchSize: 10,
      maxRetries: 5,
      maxWaitTimeMs: 5_000,
      retryDelay: 30,
      deadLetterQueue: apnsDeliveryDeadLetterQueue.queueName as unknown as string,
    }).subscribe((stream) =>
      Stream.runForEach(stream, (message) =>
        Effect.gen(function* () {
          const settings = yield* getSettings;
          const result = yield* Effect.gen(function* () {
            const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
            return yield* deliveries.processSignedJob(message.body);
          }).pipe(Effect.provide(makeRuntimeLayer(settings)));
          yield* Effect.logInfo("apns delivery queue job processed", {
            deviceId: result.deviceId,
            kind: result.kind,
            ok: result.ok,
            apnsStatus: result.apnsStatus,
            apnsReason: result.apnsReason,
          });
        }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("apns delivery queue job failed", { cause }),
          ),
          Effect.provide(relayTelemetryLayer),
        ),
      ),
    );

    yield* Cloudflare.cron("*/5 * * * *").subscribe(() =>
      Effect.gen(function* () {
        yield* DpopProofs.pruneExpired(db);
        yield* recordRelayProductStateMetrics(db);
        yield* Effect.logInfo("relay product metric snapshot recorded");
      }).pipe(Effect.provide(relayTelemetryLayer)),
    );

    // HttpApiBuilder captures its construction context for route handlers, so a
    // traced build would become the parent of subsequent request handler spans.
    const buildFetch = Effect.fnUntraced(function* () {
      const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const settings = yield* getSettings;
      const handler = yield* HttpApiBuilder.layer(RelayApi).pipe(
        Layer.provide(makeAppLayer(settings)),
        Layer.provide(relayTelemetryLayer),
        Layer.provide([Etag.layerWeak, RelayHttpPlatformLayer, relayCors]),
        HttpRouter.toHttpEffect,
      );
      const tracer = yield* Effect.tracer;
      const completedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      yield* Effect.logInfo("relay worker http handler built", {
        durationMs: completedAt - startedAt,
      });
      return { handler: traceRelayHttpRequest(handler, tracer) };
    });
    const getFetch = yield* Effect.cached(buildFetch().pipe(Effect.provide(relayTelemetryLayer)));
    const fetch = getFetch.pipe(Effect.map(({ handler }) => handler));

    return { fetch };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.HyperdriveBindingLive,
        Cloudflare.CronEventSourceLive,
        Cloudflare.QueueBindingLive,
        Cloudflare.QueueEventSourceLive,
      ),
    ),
  ),
) {}
