import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Config from "effect/Config";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { RelayApi } from "@t3tools/contracts/relay";

import {
  clientApi,
  dpopClientApi,
  healthApi,
  metadataApi,
  mobileApi,
  relayClientAuthLayer,
  relayDpopClientAuthLayer,
  relayCors,
  relayEnvironmentAuthLayer,
  relayNotFoundRoute,
  serverApi,
  traceRelayHttpRequestWith,
  tokenApi,
  withoutCapturedParentSpan,
} from "./http/Api.ts";
import {
  CLOUDFLARE_ACCOUNT_ID,
  MANAGED_ENDPOINT_ZONE_ID,
  MANAGED_ENDPOINT_ZONE_NAME,
  ManagedEndpointProvisionerToken,
  RELAY_PUBLIC_DOMAIN,
  RELAY_PUBLIC_ORIGIN,
} from "./managedEndpointStack.ts";
import { makeRelayTraceLayer, RelayObservability } from "./observability.ts";
import * as DeliveryAttempts from "./agentActivity/DeliveryAttempts.ts";
import * as AgentActivityRows from "./agentActivity/AgentActivityRows.ts";
import * as Devices from "./agentActivity/Devices.ts";
import * as DpopProofs from "./auth/DpopProofs.ts";
import * as RelayTokens from "./auth/RelayTokens.ts";
import * as EnvironmentCredentials from "./environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./environments/EnvironmentLinks.ts";
import * as LiveActivities from "./agentActivity/LiveActivities.ts";
import { RelayDb, RelayHyperdrive } from "./db.ts";
import { RelayApnsDeliveryDeadLetterQueue, RelayApnsDeliveryQueue } from "./queues.ts";
import * as RelayConfiguration from "./Config.ts";
import * as AgentActivityPublisher from "./agentActivity/AgentActivityPublisher.ts";
import * as ApnsClient from "./agentActivity/ApnsClient.ts";
import * as ApnsDeliveryQueue from "./agentActivity/ApnsDeliveryQueue.ts";
import * as ApnsDeliveries from "./agentActivity/ApnsDeliveries.ts";
import * as EnvironmentConnector from "./environments/EnvironmentConnector.ts";
import * as EnvironmentLinker from "./environments/EnvironmentLinker.ts";
import * as EnvironmentPublishSignatures from "./environments/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointProvider from "./environments/ManagedEndpointProvider.ts";
import * as MobileRegistrations from "./agentActivity/MobileRegistrations.ts";

const webcryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

const httpPlatformNotSupportedLayer = Layer.succeed(HttpPlatform.HttpPlatform, {
  fileResponse: () => Effect.die("Relay API does not serve filesystem responses"),
  fileWebResponse: () => Effect.die("Relay API does not serve file responses"),
});

const relayApiLayer = Layer.mergeAll(
  healthApi,
  metadataApi,
  mobileApi,
  clientApi,
  tokenApi,
  dpopClientApi,
  serverApi,
);

const CloudMintKeyPair = Alchemy.KeyPair("CloudMintKeyPair");
const ApnsDeliveryJobSigningSecret = Alchemy.makeRandom("ApnsDeliveryJobSigningSecret", {
  bytes: 32,
});

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.filename,
    compatibility: {
      date: "2026-05-22",
      flags: ["nodejs_compat"],
    },
    domain: RELAY_PUBLIC_DOMAIN,
  },
  Effect.gen(function* () {
    //
    // 1. Provision Infrastructure for the Worker to use
    //
    const apnsDeliveryQueue = yield* RelayApnsDeliveryQueue;
    const apnsDeliveryDeadLetterQueue = yield* RelayApnsDeliveryDeadLetterQueue;
    const apnsDeliveryQueueSender = yield* Cloudflare.QueueBinding.bind(apnsDeliveryQueue);
    const alchemyRuntimeContext = yield* Alchemy.RuntimeContext;
    const cloudMintKeyPair = yield* CloudMintKeyPair;
    const hyperdrive = yield* Cloudflare.Hyperdrive.bind(yield* RelayHyperdrive);
    const managedEndpointProvisionerToken = yield* ManagedEndpointProvisionerToken;
    const managedEndpointCloudflareApiToken = yield* managedEndpointProvisionerToken.value;
    const randomApnsDeliveryJobSigningSecret = yield* ApnsDeliveryJobSigningSecret;
    const observability = yield* RelayObservability;

    //
    // 2. Create bindings
    //
    const environment = yield* Config.schema(
      RelayConfiguration.ApnsEnvironment,
      "APNS_ENVIRONMENT",
    );
    const apnsTeamId = yield* Config.string("APNS_TEAM_ID");
    const apnsKeyId = yield* Config.string("APNS_KEY_ID");
    const apnsBundleId = yield* Config.string("APNS_BUNDLE_ID");
    const apnsPrivateKey = yield* Config.redacted("APNS_PRIVATE_KEY");
    const apnsDeliveryJobSigningSecret = yield* randomApnsDeliveryJobSigningSecret;

    const axiomDatasetName = yield* observability.traces.name;
    const axiomIngestToken = yield* observability.ingestToken.token;
    const axiomTracesEndpoint = yield* observability.traces.otelTracesEndpoint;

    const clerkSecretKey = yield* Config.redacted("CLERK_SECRET_KEY");

    const cloudMintPrivateKey = yield* cloudMintKeyPair.privateKey;
    const cloudMintPublicKey = yield* cloudMintKeyPair.publicKey;
    const db = yield* Drizzle.postgres(hyperdrive.connectionString);
    const queueSender = ApnsDeliveryQueue.ApnsDeliveryQueueSender.of({
      send: (body) =>
        apnsDeliveryQueueSender.send(body).pipe(
          Effect.mapError((cause) => new ApnsDeliveryQueue.ApnsDeliveryQueueSendError({ cause })),
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
        ),
    });

    //
    // 3. Runtime layers and app construction
    //

    const loadSettings = Effect.gen(function* () {
      return RelayConfiguration.RelayConfiguration.of({
        relayIssuer: RELAY_PUBLIC_ORIGIN,
        apns: {
          environment,
          teamId: apnsTeamId,
          keyId: apnsKeyId,
          bundleId: apnsBundleId,
          privateKey: apnsPrivateKey,
        },
        apnsDeliveryJobSigningSecret: yield* apnsDeliveryJobSigningSecret,
        clerkSecretKey,
        cloudMintPrivateKey: yield* cloudMintPrivateKey,
        cloudMintPublicKey: yield* cloudMintPublicKey,
        managedEndpointBaseDomain: MANAGED_ENDPOINT_ZONE_NAME,
        cloudflareAccountId: CLOUDFLARE_ACCOUNT_ID,
        cloudflareZoneId: MANAGED_ENDPOINT_ZONE_ID,
        cloudflareApiToken: yield* managedEndpointCloudflareApiToken,
      });
    });

    const relayTraceLayer = Layer.unwrap(
      Effect.all({
        tracesDatasetName: axiomDatasetName,
        tracesEndpoint: axiomTracesEndpoint,
        ingestToken: axiomIngestToken,
      }).pipe(Effect.map(makeRelayTraceLayer)),
    );

    const runtimeLayer = Layer.unwrap(
      Effect.gen(function* () {
        const settings = yield* loadSettings;

        return Layer.mergeAll(
          MobileRegistrations.layer.pipe(Layer.provideMerge(AgentActivityPublisher.layer)),
          EnvironmentConnector.layer,
          EnvironmentLinker.layer.pipe(
            Layer.provideMerge(ManagedEndpointProvider.layer),
            Layer.provideMerge(DpopProofs.layer),
          ),
          EnvironmentPublishSignatures.layer.pipe(Layer.provideMerge(DpopProofs.layer)),
          DpopProofs.layer,
        ).pipe(
          Layer.provide(ApnsDeliveries.layer.pipe(Layer.provide(ApnsClient.layer))),
          Layer.provide(ApnsDeliveryQueue.layer),
          Layer.provide(AgentActivityRows.layer),
          Layer.provide(Devices.layer),
          Layer.provide(EnvironmentCredentials.layer),
          Layer.provide(EnvironmentLinks.layer),
          Layer.provide(LiveActivities.layer),
          Layer.provide(DeliveryAttempts.layer),
          Layer.provide(RelayTokens.layer),
          Layer.provide(Layer.succeed(RelayDb, db)),
          Layer.provide(Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, queueSender)),
          Layer.provide(Layer.succeed(RelayConfiguration.RelayConfiguration, settings)),
          Layer.provide(webcryptoLayer),
        );
      }),
    );

    const appLayer = Layer.unwrap(
      Effect.gen(function* () {
        const settings = yield* loadSettings;
        return relayApiLayer.pipe(
          Layer.provide(runtimeLayer),
          Layer.provide(relayClientAuthLayer),
          Layer.provide(relayDpopClientAuthLayer),
          Layer.provide(relayEnvironmentAuthLayer),
          Layer.provide(EnvironmentCredentials.layer),
          Layer.provide(EnvironmentLinks.layer),
          Layer.provide(RelayTokens.layer),
          Layer.provide(Layer.succeed(RelayDb, db)),
          Layer.provideMerge(Layer.succeed(RelayConfiguration.RelayConfiguration, settings)),
          Layer.provide(webcryptoLayer),
        );
      }),
    );

    yield* Cloudflare.messages<unknown>(apnsDeliveryQueue, {
      batchSize: 10,
      maxRetries: 5,
      maxWaitTime: "5 seconds",
      retryDelay: "30 seconds",
      // Alchemy beta.45 expects a resolved string here although Queue names are Outputs.
      deadLetterQueue: apnsDeliveryDeadLetterQueue.queueName as unknown as string,
    }).subscribe((stream) =>
      stream.pipe(
        Stream.withSpan("relay.apn_delivery_queue.process_batch"),
        Stream.runForEach(
          Effect.fn("relay.apn_delivery_queue.process_message")((message) =>
            ApnsDeliveries.ApnsDeliveries.pipe(
              Effect.flatMap((deliveries) => deliveries.processSignedJob(message.body)),
            ),
          ),
        ),
        Effect.provide(runtimeLayer),
      ),
    );

    yield* Cloudflare.cron("*/5 * * * *").subscribe(() =>
      DpopProofs.DpopProofReplay.pipe(
        Effect.flatMap((dpopProofs) => dpopProofs.pruneExpired),
        Effect.withSpan("relay.cron.prune_expired_dpop_proofs"),
        Effect.provide(runtimeLayer),
      ),
    );

    const fetch = Layer.merge(
      HttpApiBuilder.layer(RelayApi).pipe(
        Layer.provide(appLayer),
        Layer.provide([Etag.layerWeak, httpPlatformNotSupportedLayer, relayCors]),
      ),
      relayNotFoundRoute,
    ).pipe(
      HttpRouter.toHttpEffect,
      withoutCapturedParentSpan,
      Effect.flatMap((httpEffect) => traceRelayHttpRequestWith(httpEffect, relayTraceLayer)),
    );

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
