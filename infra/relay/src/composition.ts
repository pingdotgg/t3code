import * as Config from "effect/Config";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiScalar from "effect/http-api/HttpApiScalar";

import { RelayApi } from "@t3tools/contracts/relay";

import {
  RELAY_HTTP_ROUTER_CONFIG,
  traceRelayHttpRequestWith,
  withoutCapturedParentSpan,
} from "./http/Api.ts";
import * as RelayHttpApi from "./http/Api.ts";
import type { RelayHost } from "./host/RelayHost.ts";
import * as Ports from "./host/ports.ts";
import * as Observability from "./observability.ts";
import * as DeliveryAttempts from "./agentActivity/DeliveryAttempts.ts";
import * as AgentActivityRows from "./agentActivity/AgentActivityRows.ts";
import * as Devices from "./agentActivity/Devices.ts";
import * as DpopProofs from "./auth/DpopProofs.ts";
import { makeOidcKeySet, makeOidcVerifier } from "./auth/SubjectTokens.ts";
import * as CloudMintSigner from "./auth/CloudMintSigner.ts";
import * as RelayTokens from "./auth/RelayTokens.ts";
import * as EnvironmentCredentials from "./environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./environments/EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "./environments/ManagedEndpointAllocations.ts";
import * as LiveActivities from "./agentActivity/LiveActivities.ts";
import * as RelayDb from "./db.ts";
import * as WebCrypto from "./WebCrypto.ts";
import * as FcmAssertionSigner from "./agentActivity/FcmAssertionSigner.ts";
import * as FcmClient from "./agentActivity/FcmClient.ts";
import * as FcmDeliveryQueueSender from "./agentActivity/FcmDeliveryQueueSender.ts";
import * as FcmDeliveries from "./agentActivity/FcmDeliveries.ts";
import * as FcmDeliveryQueueConsumer from "./agentActivity/FcmDeliveryQueueConsumer.ts";
import * as RelayConfiguration from "./Config.ts";
import * as AgentActivityPublisher from "./agentActivity/AgentActivityPublisher.ts";
import * as ApnsClient from "./agentActivity/ApnsClient.ts";
import * as ApnsProviderTokens from "./agentActivity/ApnsProviderTokens.ts";
import * as ApnsDeliveryQueue from "./agentActivity/ApnsDeliveryQueue.ts";
import * as ApnsDeliveries from "./agentActivity/ApnsDeliveries.ts";
import * as CloudflareApiPause from "./environments/CloudflareApiPause.ts";
import * as EnvironmentConnector from "./environments/EnvironmentConnector.ts";
import * as EnvironmentLinker from "./environments/EnvironmentLinker.ts";
import * as EnvironmentPublishSignatures from "./environments/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointProvider from "./environments/ManagedEndpointProvider.ts";
import * as ManagedEndpointReaper from "./environments/ManagedEndpointReaper.ts";
import * as ManagedTunnelLimits from "./environments/ManagedTunnelLimits.ts";
import * as T3ChatAccounts from "./t3chat/T3ChatAccounts.ts";
import * as MobileRegistrations from "./agentActivity/MobileRegistrations.ts";
import * as HookForwarder from "./hooks/HookForwarder.ts";
import * as HeldHooks from "./hooks/HeldHooks.ts";
import * as MobileTelemetry from "./mobileTelemetry/MobileTelemetry.ts";

const layerWebcrypto = Layer.mergeAll(
  Digest.layerWebCrypto,
  Mac.layerWebCrypto,
  Signature.layerWebCrypto,
).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));

const layerHttpPlatformNotSupported = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: Effect.fn("HttpPlatform.fileResponse")(function () {
    return Effect.die("Relay API does not serve filesystem responses");
  }),
  fileWebResponse: Effect.fn("HttpPlatform.fileWebResponse")(function () {
    return Effect.die("Relay API does not serve file responses");
  }),
});

const layerRelayApi = Layer.mergeAll(
  RelayHttpApi.layerHealthApi,
  RelayHttpApi.layerMetadataApi,
  RelayHttpApi.layerMobileApi,
  RelayHttpApi.layerClientApi,
  RelayHttpApi.layerTokenApi,
  RelayHttpApi.layerDpopClientApi,
  RelayHttpApi.layerServerApi,
);

// Platform-neutral: the Cloudflare and Node hosts (see `host/RelayHost.ts`) supply the I/O.
export const composeRelay = Effect.fn("relay.composition.compose")(function* <R>(
  host: RelayHost<R>,
) {
  const { relayPublicOrigin, stage } = host.deployment;

  const apnsEnabled = yield* Config.Boolean("APNS_ENABLED").pipe(Config.withDefault(true));
  const apnsCredentials = apnsEnabled
    ? {
        environment: yield* Config.schema(RelayConfiguration.ApnsEnvironment, "APNS_ENVIRONMENT"),
        teamId: yield* Config.String("APNS_TEAM_ID"),
        keyId: yield* Config.String("APNS_KEY_ID"),
        bundleId: yield* Config.String("APNS_BUNDLE_ID"),
        privateKey: yield* Config.Redacted("APNS_PRIVATE_KEY"),
      }
    : null;
  const fcmServiceAccount = Option.getOrUndefined(
    Option.filter(
      yield* Config.option(Config.Redacted("FCM_SERVICE_ACCOUNT")),
      (value) => Redacted.value(value).trim().length > 0,
    ),
  );
  const apnsDeliveryJobSigningSecret = host.apnsJobSigningSecret;
  const apnsDeliveryQueueSender = yield* host.apnsSender;
  const fcmDeliveryQueueSender = yield* host.fcmSender;

  // Clerk is optional: a self-hosted relay can authenticate with OIDC alone.
  const clerkSecretKey = Option.getOrUndefined(
    yield* Config.option(Config.Redacted("CLERK_SECRET_KEY")),
  );
  const clerkPublishableKey = Option.getOrUndefined(
    yield* Config.option(Config.String("CLERK_PUBLISHABLE_KEY")),
  );
  const clerkJwtAudience = Option.getOrUndefined(
    yield* Config.option(Config.String("CLERK_JWT_AUDIENCE")),
  );
  // Optional second identity provider for self-hosted relays; Clerk keeps working alongside it.
  const oidcIssuer = Option.getOrUndefined(yield* Config.option(Config.String("OIDC_ISSUER")));
  const oidcAudience = Option.getOrUndefined(yield* Config.option(Config.String("OIDC_AUDIENCE")));
  if (oidcIssuer !== undefined && oidcAudience === undefined) {
    return yield* Effect.die("OIDC_AUDIENCE is required when OIDC_ISSUER is set.");
  }
  const oidcVerify =
    oidcIssuer === undefined || oidcAudience === undefined
      ? undefined
      : yield* makeOidcVerifier({
          issuer: oidcIssuer,
          audience: oidcAudience,
          keySet: (yield* makeOidcKeySet(oidcIssuer))[0],
        }).pipe(Effect.provide(layerWebcrypto));
  // Off unless a self-hosted relay turns it on: the hosted relay keeps refusing unmanaged links.
  const manualEndpoints = yield* Config.schema(
    RelayConfiguration.ManualEndpointsMode,
    "RELAY_MANUAL_ENDPOINTS",
  ).pipe(Config.withDefault("off"));
  const t3ChatLinkSecret = Option.getOrUndefined(
    Option.filter(
      yield* Config.option(Config.Redacted("T3CHAT_LINK_SECRET")),
      (value) => Redacted.value(value).trim().length > 0,
    ),
  );
  const t3ChatBaseUrl = yield* Config.String("T3CHAT_URL").pipe(
    Config.withDefault("https://t3.chat"),
  );

  const cloudMintPrivateKey = Effect.map(host.mintKeyPair, (keys) => keys.privateKey);
  const cloudMintPublicKey = Effect.map(host.mintKeyPair, (keys) => keys.publicKey);
  const db = host.database;
  const managedEndpointCleanupMode = yield* RelayConfiguration.managedEndpointCleanupModeConfig;
  const legacyManagedEndpointCleanupMode =
    yield* RelayConfiguration.legacyManagedEndpointCleanupModeConfig;
  const legacyTunnelGraceMinutes = Option.getOrUndefined(
    yield* RelayConfiguration.legacyTunnelGraceMinutesConfig,
  );
  const loadSettings = Effect.gen(function* () {
    return RelayConfiguration.RelayConfiguration.of({
      relayIssuer: relayPublicOrigin,
      ...(fcmServiceAccount ? { fcmServiceAccount } : {}),
      apns: apnsCredentials,
      apnsDeliveryJobSigningSecret: yield* apnsDeliveryJobSigningSecret,
      ...(clerkSecretKey === undefined ? {} : { clerkSecretKey }),
      ...(clerkPublishableKey === undefined ? {} : { clerkPublishableKey }),
      ...(clerkJwtAudience === undefined ? {} : { clerkJwtAudience }),
      manualEndpoints,
      ...(oidcIssuer === undefined || oidcVerify === undefined
        ? {}
        : { oidc: { issuer: oidcIssuer, verify: oidcVerify } }),
      cloudMintPrivateKey: yield* cloudMintPrivateKey,
      cloudMintPublicKey: yield* cloudMintPublicKey,
      managedEndpointBaseDomain: host.managedEndpointBaseDomain,
      managedEndpointNamespace: stage,
      managedEndpointCleanupMode,
      legacyManagedEndpointCleanupMode,
      ...(legacyTunnelGraceMinutes === undefined ? {} : { legacyTunnelGraceMinutes }),
      ...(t3ChatLinkSecret
        ? { t3Chat: { baseUrl: t3ChatBaseUrl, linkSecret: t3ChatLinkSecret } }
        : {}),
    });
  });

  const layerHookInbox = host.hookInbox;

  const layerRuntime = Layer.empty.pipe(
    Layer.provideMerge(MobileRegistrations.layer),
    Layer.provideMerge(AgentActivityPublisher.layer),
    Layer.provideMerge(EnvironmentConnector.layer),
    Layer.provideMerge(EnvironmentLinker.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        EnvironmentPublishSignatures.layer,
        ManagedEndpointReaper.layer,
        HeldHooks.layer,
      ),
    ),
    Layer.provideMerge(
      ManagedEndpointProvider.layer.pipe(Layer.provideMerge(host.managedEndpointClients)),
    ),
    Layer.provideMerge(DpopProofs.layer),
    Layer.provideMerge(ApnsDeliveries.layer),
    Layer.provideMerge(
      FcmDeliveries.layer.pipe(
        Layer.provide(
          Layer.succeed(FcmDeliveryQueueSender.FcmDeliveryQueueSender, fcmDeliveryQueueSender),
        ),
        Layer.provideMerge(
          FcmClient.layer.pipe(
            Layer.provide(FcmAssertionSigner.layer),
            Layer.provide(Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle })),
          ),
        ),
      ),
    ),
    Layer.provideMerge(ApnsClient.layer.pipe(Layer.provideMerge(ApnsProviderTokens.layer))),
    Layer.provideMerge(ApnsDeliveryQueue.layerWithSender(apnsDeliveryQueueSender)),
    Layer.provideMerge(Layer.mergeAll(AgentActivityRows.layer, Devices.layer, layerHookInbox)),
    Layer.provideMerge(EnvironmentCredentials.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        CloudflareApiPause.layer,
        EnvironmentLinks.layer,
        ManagedEndpointAllocations.layer,
        ManagedTunnelLimits.layer,
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(LiveActivities.layer, T3ChatAccounts.layer)),
    Layer.provideMerge(DeliveryAttempts.layer),
    Layer.provideMerge(RelayTokens.layer.pipe(Layer.provideMerge(CloudMintSigner.layer))),
    Layer.provideMerge(
      RelayDb.RelayTransactions.layer.pipe(Layer.provideMerge(Layer.succeed(RelayDb.RelayDb, db))),
    ),
    Layer.provideMerge(Layer.effect(RelayConfiguration.RelayConfiguration, loadSettings)),
    Layer.provideMerge(layerWebcrypto),
  );

  // Fails open: a limiter outage must not drop webhooks or app telemetry.
  const allowWith =
    (
      limit: (key: string) => Effect.Effect<boolean, Ports.RateLimitUnavailableError>,
      failedOpenAttribute = "relay.hook.rate_limiter_failed_open",
    ) =>
    (key: string): Effect.Effect<boolean> =>
      limit(key).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Rate limiter unavailable", { error: String(error) }).pipe(
            Effect.andThen(Effect.annotateCurrentSpan({ [failedOpenAttribute]: true })),
            Effect.as(true),
          ),
        ),
      );
  const layerHookRateLimiter = Layer.succeed(HookForwarder.HookRateLimiter, {
    allowHook: allowWith(host.rateLimits.hook),
    allowEndpoint: allowWith(host.rateLimits.hookEndpoint),
  });

  // `fetch` rebuilds its layers per request; the source map cache must outlive one.
  const mobileSourceMapLookups = yield* MobileTelemetry.SourceMaps.pipe(
    Effect.provide(MobileTelemetry.layerSourceMaps),
    Effect.provideService(MobileTelemetry.SourceMapObjects, yield* host.mobileTelemetry.sourceMaps),
  );
  const layerMobileTelemetry = MobileTelemetry.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.effect(MobileTelemetry.MobileTelemetrySettings, host.mobileTelemetry.settings),
        Layer.succeed(MobileTelemetry.MobileTelemetryRateLimiter, {
          allow: allowWith(
            host.rateLimits.mobileTelemetry,
            "relay.mobile_telemetry.rate_limiter_failed_open",
          ),
        }),
        Layer.succeed(MobileTelemetry.SourceMaps, mobileSourceMapLookups),
      ),
    ),
  );

  const layerApp = Layer.mergeAll(
    layerRelayApi,
    HookForwarder.layerApi.pipe(
      Layer.provide(HookForwarder.layer),
      Layer.provide(layerHookRateLimiter),
    ),
    MobileTelemetry.layerApi.pipe(Layer.provide(layerMobileTelemetry)),
  ).pipe(
    Layer.provideMerge(RelayHttpApi.layerClientAuth),
    Layer.provideMerge(RelayHttpApi.layerDpopClientAuth),
    Layer.provideMerge(RelayHttpApi.layerEnvironmentAuth),
    Layer.provide(layerRuntime),
  );

  yield* host.consumeQueue(
    "apns",
    { batchSize: 10, maxRetries: 5, retryDelay: "30 seconds" },
    (body) =>
      ApnsDeliveries.ApnsDeliveries.pipe(
        Effect.flatMap((deliveries) => deliveries.processSignedJob(body)),
        Effect.asVoid,
        Effect.mapError((cause) => new Ports.QueueHandlerError({ cause })),
        Effect.withSpan("relay.apn_delivery_queue.process_message"),
        Effect.provide(layerRuntime),
      ),
  );

  yield* host.consumeQueue(
    "fcm",
    { batchSize: 10, maxRetries: 5, retryDelay: "30 seconds" },
    (body) =>
      FcmDeliveryQueueConsumer.processMessage(body).pipe(
        Effect.mapError((cause) => new Ports.QueueHandlerError({ cause })),
        Effect.provide(layerRuntime),
      ),
  );

  yield* host.schedule(
    "*/5 * * * *",
    Effect.all(
      [
        DpopProofs.DpopProofReplay.pipe(
          Effect.flatMap((dpopProofs) => dpopProofs.pruneExpired),
          Effect.andThen(
            Effect.all([AgentActivityRows.AgentActivityRows, DateTime.now]).pipe(
              Effect.flatMap(([activityRows, now]) =>
                activityRows.pruneTerminal({
                  updatedBefore: DateTime.formatIso(DateTime.subtract(now, { minutes: 30 })),
                }),
              ),
            ),
          ),
          Effect.andThen(
            DeliveryAttempts.DeliveryAttempts.pipe(
              Effect.flatMap((attempts) => attempts.pruneExpired),
            ),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.logWarning("Failed to prune expired relay state", { cause }),
          ),
        ),
        ManagedEndpointReaper.ManagedEndpointReaper.pipe(
          Effect.flatMap((reaper) => reaper.sweep.pipe(Effect.timeout("2 minutes"))),
          Effect.tap((result) =>
            result.scanned > 0
              ? Effect.logInfo("Finished managed tunnel cleanup", result)
              : Effect.void,
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.logWarning("Failed to clean up inactive managed tunnels", { cause }),
          ),
        ),
        AgentActivityPublisher.AgentActivityPublisher.pipe(
          Effect.flatMap((publisher) => publisher.endIdleLiveActivities),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.logWarning("Failed to end idle Live Activities", { cause }),
          ),
        ),
      ],
      { concurrency: 3, discard: true },
    ).pipe(
      Effect.withSpan("relay.cron.prune_expired_state"),
      Observability.withSchemaErrorSpanAttributes,
      Effect.provide(layerRuntime),
    ),
  );

  const fetch = Layer.merge(
    Layer.mergeAll(
      HttpApiBuilder.layer(RelayApi, { openapiPath: "/openapi.json" }).pipe(
        Layer.provide(layerApp),
      ),
      HttpApiScalar.layer(RelayApi, { path: "/docs" }),
      RelayHttpApi.layerDocsRedirectRoute,
    ).pipe(Layer.provide([Etag.layerWeak, layerHttpPlatformNotSupported, RelayHttpApi.layerCors])),
    RelayHttpApi.layerNotFoundRoute,
  ).pipe(
    HttpRouter.toHttpEffect,
    Effect.provideService(HttpRouter.RouterConfig, RELAY_HTTP_ROUTER_CONFIG),
    withoutCapturedParentSpan,
    Effect.map((httpEffect) =>
      traceRelayHttpRequestWith(httpEffect, Layer.empty).pipe(
        Observability.withSchemaErrorSpanAttributes,
      ),
    ),
  );

  // The runtime is exposed so a host can build it once and provide it to every request.
  return { fetch, runtime: layerRuntime };
});
