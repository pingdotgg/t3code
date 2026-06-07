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
import * as HttpApiScalar from "effect/unstable/httpapi/HttpApiScalar";

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
  relayDocsRedirectRoute,
  relayEnvironmentAuthLayer,
  relayNotFoundRoute,
  serverApi,
  traceRelayHttpRequestWith,
  tokenApi,
  withoutCapturedParentSpan,
} from "./http/Api.ts";
import { ManagedEndpointZone, RelayApiZone, RelayDeploymentConfig } from "./zone.ts";
import { makeRelayTraceLayer, RelayObservability } from "./observability.ts";
import * as DeliveryAttempts from "./agentActivity/DeliveryAttempts.ts";
import * as AgentActivityRows from "./agentActivity/AgentActivityRows.ts";
import * as Devices from "./agentActivity/Devices.ts";
import * as DpopProofs from "./auth/DpopProofs.ts";
import * as RelayTokens from "./auth/RelayTokens.ts";
import * as EnvironmentCredentials from "./environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./environments/EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "./environments/ManagedEndpointAllocations.ts";
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
  RelayDeploymentConfig.pipe(
    Effect.map(({ relayPublicDomain }) => ({
      main: import.meta.filename,
      compatibility: {
        date: "2026-05-22",
        flags: ["nodejs_compat"],
      },
      domain: relayPublicDomain,
    })),
    Effect.orDie,
  ),
  Effect.gen(function* () {
    //
    // 1. Provision Infrastructure for the Worker to use
    //
    const { relayPublicOrigin, stage } = yield* RelayDeploymentConfig;
    const apnsDeliveryQueue = yield* RelayApnsDeliveryQueue;
    const apnsDeliveryDeadLetterQueue = yield* RelayApnsDeliveryDeadLetterQueue;
    const cloudMintKeyPair = yield* CloudMintKeyPair;
    const relayApiZone = yield* RelayApiZone;
    const managedEndpointZone = yield* ManagedEndpointZone;
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
    const apnsDeliveryQueueSender = yield* Cloudflare.QueueBinding.bind(apnsDeliveryQueue);

    const axiomDatasetName = yield* observability.traces.name;
    const axiomIngestToken = yield* observability.workerIngestToken.token;
    const axiomTracesEndpoint = yield* observability.traces.otelTracesEndpoint;

    const clerkSecretKey = yield* Config.redacted("CLERK_SECRET_KEY");
    const clerkPublishableKey = yield* Config.string("CLERK_PUBLISHABLE_KEY");
    const clerkJwtAudience = yield* Config.string("CLERK_JWT_AUDIENCE");

    const cloudMintPrivateKey = yield* cloudMintKeyPair.privateKey;
    const cloudMintPublicKey = yield* cloudMintKeyPair.publicKey;
    const hyperdrive = yield* Cloudflare.Hyperdrive.bind(yield* RelayHyperdrive);
    const db = yield* Drizzle.postgres(hyperdrive.connectionString);

    const managedEndpointTunnelBinding = yield* Cloudflare.TunnelReadWrite.bind();
    // Keep Worker custom-domain reconciliation ordered after API zone provisioning.
    yield* yield* relayApiZone.zoneId;
    const managedEndpointDnsBinding = yield* Cloudflare.DnsReadWrite.bind(managedEndpointZone);
    const managedEndpointZoneName = yield* managedEndpointZone.name;

    //
    // 3. Runtime layers and app construction
    //
    const alchemyRuntimeContext = yield* Alchemy.RuntimeContext;

    const loadSettings = Effect.gen(function* () {
      return RelayConfiguration.RelayConfiguration.of({
        relayIssuer: relayPublicOrigin,
        apns: {
          environment,
          teamId: apnsTeamId,
          keyId: apnsKeyId,
          bundleId: apnsBundleId,
          privateKey: apnsPrivateKey,
        },
        apnsDeliveryJobSigningSecret: yield* apnsDeliveryJobSigningSecret,
        clerkSecretKey,
        clerkPublishableKey,
        clerkJwtAudience,
        cloudMintPrivateKey: yield* cloudMintPrivateKey,
        cloudMintPublicKey: yield* cloudMintPublicKey,
        managedEndpointBaseDomain: yield* managedEndpointZoneName,
        managedEndpointNamespace: stage,
      });
    });

    const relayTraceLayer = Layer.unwrap(
      Effect.all({
        tracesDatasetName: axiomDatasetName,
        tracesEndpoint: axiomTracesEndpoint,
        ingestToken: axiomIngestToken,
      }).pipe(Effect.map(makeRelayTraceLayer)),
    );

    const runtimeLayer = Layer.empty.pipe(
      Layer.provideMerge(MobileRegistrations.layer),
      Layer.provideMerge(AgentActivityPublisher.layer),
      Layer.provideMerge(EnvironmentConnector.layer),
      Layer.provideMerge(EnvironmentLinker.layer),
      Layer.provideMerge(EnvironmentPublishSignatures.layer),
      Layer.provideMerge(
        ManagedEndpointProvider.layerCloudflareBindings(
          managedEndpointTunnelBinding,
          managedEndpointDnsBinding,
          alchemyRuntimeContext,
        ),
      ),
      Layer.provideMerge(DpopProofs.layer),
      Layer.provideMerge(ApnsDeliveries.layer),
      Layer.provideMerge(ApnsClient.layer),
      Layer.provideMerge(
        ApnsDeliveryQueue.layerCloudflareQueues(apnsDeliveryQueueSender, alchemyRuntimeContext),
      ),
      Layer.provideMerge(AgentActivityRows.layer),
      Layer.provideMerge(Devices.layer),
      Layer.provideMerge(EnvironmentCredentials.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          EnvironmentLinks.layer,
          ManagedEndpointAllocations.ManagedEndpointAllocations.layer,
        ),
      ),
      Layer.provideMerge(LiveActivities.layer),
      Layer.provideMerge(DeliveryAttempts.layer),
      Layer.provideMerge(RelayTokens.layer),
      Layer.provideMerge(Layer.succeed(RelayDb, db)),
      Layer.provideMerge(Layer.effect(RelayConfiguration.RelayConfiguration, loadSettings)),
      Layer.provideMerge(webcryptoLayer),
    );

    const appLayer = relayApiLayer.pipe(
      Layer.provideMerge(relayClientAuthLayer),
      Layer.provideMerge(relayDpopClientAuthLayer),
      Layer.provideMerge(relayEnvironmentAuthLayer),
      Layer.provide(runtimeLayer),
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
        Stream.runForEach((message) =>
          ApnsDeliveries.ApnsDeliveries.pipe(
            Effect.flatMap((deliveries) => deliveries.processSignedJob(message.body)),
            Effect.withSpan("relay.apn_delivery_queue.process_message"),
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
      Layer.mergeAll(
        HttpApiBuilder.layer(RelayApi, { openapiPath: "/openapi.json" }).pipe(
          Layer.provide(appLayer),
        ),
        HttpApiScalar.layer(RelayApi, { path: "/docs" }),
        relayDocsRedirectRoute,
      ).pipe(Layer.provide([Etag.layerWeak, httpPlatformNotSupportedLayer, relayCors])),
      relayNotFoundRoute,
    ).pipe(
      HttpRouter.toHttpEffect,
      withoutCapturedParentSpan,
      Effect.flatMap((httpEffect) => traceRelayHttpRequestWith(httpEffect, relayTraceLayer)),
    );

    return { fetch };
  }).pipe(
    Effect.provide(
      Layer.empty.pipe(
        Layer.provideMerge(Cloudflare.HyperdriveBindingLive),
        Layer.provideMerge(Cloudflare.CronEventSourceLive),
        Layer.provideMerge(Cloudflare.QueueBindingLive),
        Layer.provideMerge(Cloudflare.QueueEventSourceLive),
        Layer.provideMerge(Cloudflare.TunnelReadWriteLive),
        Layer.provideMerge(Cloudflare.DnsReadWriteLive),
      ),
    ),
  ),
) {}
