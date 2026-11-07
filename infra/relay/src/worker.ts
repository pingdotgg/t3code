import * as Alchemy from "alchemy";
import * as Axiom from "@alchemy.run/axiom";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle/Postgres";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { composeRelay } from "./composition.ts";
import * as RelayDb from "./db.ts";
import * as HookForwarder from "./hooks/HookForwarder.ts";
import * as HookInbox from "./hooks/HookInbox.ts";
import * as HookInboxObject from "./hooks/HookInboxObject.ts";
import * as ManagedEndpointProvider from "./environments/ManagedEndpointProvider.ts";
import * as MobileTelemetry from "./mobileTelemetry/MobileTelemetry.ts";
import { RelayObservability } from "./observability.ts";
import {
  RelayApnsDeliveryDeadLetterQueue,
  RelayApnsDeliveryQueue,
  RelayFcmDeliveryDeadLetterQueue,
  RelayFcmDeliveryQueue,
} from "./queues.ts";
import { ManagedEndpointZone, RelayApiZone, RelayDeploymentConfig } from "./zone.ts";
import type { RelayHost } from "./host/RelayHost.ts";
import * as Ports from "./host/ports.ts";

const CloudMintKeyPair = Alchemy.KeyPair("CloudMintKeyPair");
const ApnsDeliveryJobSigningSecret = Alchemy.makeRandom("ApnsDeliveryJobSigningSecret", {
  bytes: 32,
});

export class Api extends Cloudflare.Worker<Api, {}>()("Api") {}

// Cloudflare host: wires the platform-neutral relay (`composition.ts`) to Workers, Queues,
// Durable Objects, Hyperdrive, Rate Limiting, R2 and Cloudflare-managed tunnels.
export const layer = Api.make(
  RelayDeploymentConfig.pipe(
    Effect.map(({ relayPublicDomain }) => ({
      main: import.meta.filename,
      compatibility: {
        date: "2026-05-22",
        flags: ["nodejs_compat"],
      },
      // Requests run several Postgres queries in sequence. At the user's edge
      // each one paid the round trip to the database (~300 ms from JNB); next
      // to PlanetScale `us-west` the request pays that distance once.
      placement: { region: "aws:us-west-2" },
      domain: relayPublicDomain,
    })),
    Effect.orDie,
  ),
  Effect.gen(function* () {
    const { relayPublicOrigin, stage } = yield* RelayDeploymentConfig;
    const apnsDeliveryQueue = yield* RelayApnsDeliveryQueue;
    const apnsDeliveryDeadLetterQueue = yield* RelayApnsDeliveryDeadLetterQueue;
    const fcmDeliveryQueue = yield* RelayFcmDeliveryQueue;
    const fcmDeliveryDeadLetterQueue = yield* RelayFcmDeliveryDeadLetterQueue;
    const cloudMintKeyPair = yield* CloudMintKeyPair;
    const relayApiZone = yield* RelayApiZone;
    const managedEndpointZone = yield* ManagedEndpointZone;
    const randomApnsDeliveryJobSigningSecret = yield* ApnsDeliveryJobSigningSecret;
    const observability = yield* RelayObservability;
    const alchemyRuntimeContext: Alchemy.BaseRuntimeContext = yield* Cloudflare.Worker;
    const inRuntime = <A, E, R>(effect: Effect.Effect<A, E, R | Alchemy.RuntimeContext>) =>
      effect.pipe(Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext));

    const cloudMintPrivateKey = yield* yield* cloudMintKeyPair.privateKey;
    const cloudMintPublicKey = yield* yield* cloudMintKeyPair.publicKey;
    const apnsJobSigningSecret = yield* yield* randomApnsDeliveryJobSigningSecret;
    const apnsWriteQueue = yield* Cloudflare.Queues.WriteQueue(apnsDeliveryQueue);
    const fcmWriteQueue = yield* Cloudflare.Queues.WriteQueue(fcmDeliveryQueue);

    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(yield* RelayDb.RelayHyperdrive);
    // Named statements collide behind Hyperdrive transaction pooling (Effect-TS/effect#8320); use unnamed statements.
    const db = yield* Drizzle.Postgres(hyperdrive.connectionString, {
      client: { prepare: false },
    });
    const managedEndpointBaseDomain = yield* yield* managedEndpointZone.name;

    const tunnel = yield* Cloudflare.Tunnel.ReadWriteTunnel();
    // Keep Worker custom-domain reconciliation ordered after API zone provisioning.
    yield* yield* relayApiZone.zoneId;
    const dns = yield* Cloudflare.DNS.ReadWriteDns(managedEndpointZone);

    const hookRateLimit = yield* Cloudflare.RateLimit("HOOK_RATE_LIMIT", {
      namespaceId: 1001,
      simple: {
        limit: HookForwarder.RELAY_HOOK_RATE_LIMIT.limit,
        period: HookForwarder.RELAY_HOOK_RATE_LIMIT.periodSeconds,
      },
    });
    const hookEndpointRateLimit = yield* Cloudflare.RateLimit("HOOK_ENDPOINT_RATE_LIMIT", {
      namespaceId: 1002,
      simple: {
        limit: HookForwarder.RELAY_HOOK_ENDPOINT_RATE_LIMIT.limit,
        period: HookForwarder.RELAY_HOOK_ENDPOINT_RATE_LIMIT.periodSeconds,
      },
    });
    const mobileTelemetryRateLimit = yield* Cloudflare.RateLimit("MOBILE_TELEMETRY_RATE_LIMIT", {
      namespaceId: 1003,
      simple: {
        limit: MobileTelemetry.MOBILE_TELEMETRY_RATE_LIMIT.limit,
        period: MobileTelemetry.MOBILE_TELEMETRY_RATE_LIMIT.periodSeconds,
      },
    });
    // Fails open at the composition; here a limiter error is only reported as unavailable.
    const limitKey =
      (limiter: typeof hookRateLimit) =>
      (key: string): Effect.Effect<boolean, Ports.RateLimitUnavailableError> =>
        inRuntime(limiter.limit({ key })).pipe(
          Effect.map((result) => result.success),
          Effect.mapError((cause) => new Ports.RateLimitUnavailableError({ cause })),
        );

    const hookInboxes = yield* HookInboxObject.HookInboxObject;
    const inboxCall =
      <A>(operation: HookInbox.HookInboxError["operation"], endpointKey: string) =>
      (effect: Effect.Effect<A, never, Alchemy.RuntimeContext>) =>
        inRuntime(effect).pipe(
          Effect.catchCause((cause) =>
            Effect.fail(
              new HookInbox.HookInboxError({
                operation,
                endpointKey,
                cause: Cause.squash(cause),
              }),
            ),
          ),
        );

    const mobileSourceMaps = yield* Cloudflare.R2.ReadBucket(observability.mobileSourceMaps);
    const mobileTelemetryToken = yield* observability.mobileTelemetryIngestToken.token;
    const mobileTracesUrl = yield* observability.traces.otelTracesEndpoint;
    const mobileTracesDataset = yield* observability.traces.name;
    const mobileLogsUrl = yield* observability.mobileLogs.otelLogsEndpoint;
    const mobileLogsDataset = yield* observability.mobileLogs.name;
    const mobileMetricsUrl = yield* observability.mobileMetrics.otelMetricsEndpoint;
    const mobileMetricsDataset = yield* observability.mobileMetrics.name;

    const host: RelayHost<CloudflareEventSources> = {
      deployment: { relayPublicOrigin, stage },
      mintKeyPair: Effect.succeed({
        privateKey: cloudMintPrivateKey,
        publicKey: cloudMintPublicKey,
      }),
      apnsJobSigningSecret: Effect.succeed(apnsJobSigningSecret),
      managedEndpointBaseDomain,
      database: db,
      managedEndpointClients: ManagedEndpointProvider.layerCloudflareClients(
        tunnel,
        dns,
        alchemyRuntimeContext,
      ),
      hookInbox: Layer.succeed(HookInbox.HookInbox, {
        hold: Effect.fn("HookInbox.hold")(function ({ endpointKey, baseUrl, hook }) {
          return hookInboxes
            .getByName(endpointKey)
            .hold(hook, baseUrl)
            .pipe(inboxCall("hold", endpointKey));
        }),
        wake: Effect.fn("HookInbox.wake")(function ({ endpointKey, baseUrl }) {
          return hookInboxes
            .getByName(endpointKey)
            .wake(baseUrl)
            .pipe(inboxCall("wake", endpointKey));
        }),
        clear: Effect.fn("HookInbox.clear")(function ({ endpointKey }) {
          return hookInboxes.getByName(endpointKey).clear().pipe(inboxCall("clear", endpointKey));
        }),
      }),
      rateLimits: {
        hook: limitKey(hookRateLimit),
        hookEndpoint: limitKey(hookEndpointRateLimit),
        mobileTelemetry: limitKey(mobileTelemetryRateLimit),
      },
      mobileTelemetry: {
        settings: Effect.gen(function* () {
          return MobileTelemetry.MobileTelemetrySettings.of({
            axiomToken: yield* mobileTelemetryToken,
            destinations: {
              traces: { url: yield* mobileTracesUrl, dataset: yield* mobileTracesDataset },
              logs: { url: yield* mobileLogsUrl, dataset: yield* mobileLogsDataset },
              metrics: { url: yield* mobileMetricsUrl, dataset: yield* mobileMetricsDataset },
            },
          });
        }),
        sourceMaps: Effect.succeed({
          get: (key) =>
            inRuntime(mobileSourceMaps.get(key)).pipe(
              Effect.map((object) =>
                object === null
                  ? undefined
                  : {
                      size: object.size,
                      text: inRuntime(object.text()).pipe(
                        Effect.mapError(
                          (cause) => new MobileTelemetry.SourceMapObjectError({ key, cause }),
                        ),
                      ),
                    },
              ),
              Effect.mapError((cause) => new MobileTelemetry.SourceMapObjectError({ key, cause })),
            ),
        }),
      },
      apnsSender: Effect.succeed({
        send: (body) =>
          inRuntime(apnsWriteQueue.send(body)).pipe(
            Effect.mapError((cause) => new Ports.DeliveryQueueSendError({ cause })),
          ),
      }),
      fcmSender: Effect.succeed({
        send: (body) =>
          inRuntime(fcmWriteQueue.send(body)).pipe(
            Effect.mapError((cause) => new Ports.DeliveryQueueSendError({ cause })),
          ),
      }),
      // Acknowledge or retry each message on its own, so one bad job cannot replay its batch.
      consumeQueue: (name, options, handler) =>
        Cloudflare.Queues.consumeQueueMessages<unknown>(
          name === "apns" ? apnsDeliveryQueue : fcmDeliveryQueue,
          {
            batchSize: options.batchSize,
            maxRetries: options.maxRetries,
            maxWaitTime: name === "apns" ? "5 seconds" : "1 second",
            retryDelay: options.retryDelay,
            deadLetterQueue: (name === "apns"
              ? apnsDeliveryDeadLetterQueue
              : fcmDeliveryDeadLetterQueue
            ).queueName as unknown as string,
          },
          (stream) =>
            stream.pipe(
              Stream.withSpan(`relay.${name}_delivery_queue.process_batch`),
              Stream.runForEach((message) =>
                handler(message.body).pipe(
                  Effect.matchEffect({
                    onFailure: () => Effect.sync(() => message.retry()),
                    onSuccess: () => Effect.sync(() => message.ack()),
                  }),
                ),
              ),
            ),
        ),
      schedule: (cron, effect) => Cloudflare.Workers.cron(cron, () => effect),
    };

    return yield* composeRelay(host);
  }).pipe(
    Effect.provide(
      Layer.empty.pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provideMerge(Cloudflare.Hyperdrive.ConnectBinding),
        Layer.provideMerge(Cloudflare.Workers.CronEventSourceLive),
        Layer.provideMerge(Cloudflare.Queues.WriteQueueBinding),
        Layer.provideMerge(Cloudflare.Queues.EventSourceLive),
        Layer.provideMerge(Cloudflare.Tunnel.ReadWriteTunnelBinding),
        Layer.provideMerge(Cloudflare.DNS.ReadWriteDnsHttp),
        Layer.provideMerge(Cloudflare.Workers.RateLimitBinding),
        Layer.provideMerge(Cloudflare.R2.ReadBucketBinding),
        Layer.provideMerge(HookInboxObject.layer),
        // Disable the duplicate runtime span; ours applies route/header/token redaction and rejects sender traceparent.
        Layer.provideMerge(
          Alchemy.Telemetry.layer(Layer.succeed(HttpMiddleware.TracerDisabledWhen)(() => true)),
        ),
        Layer.provideMerge(
          Layer.unwrap(
            Effect.map(RelayObservability, (observability) =>
              Axiom.Telemetry({
                serviceName: "t3code-relay",
                token: observability.workerIngestToken,
                traces: observability.traces,
              }),
            ),
          ),
        ),
      ),
    ),
  ),
);

type CloudflareEventSources =
  | Layer.Success<typeof Cloudflare.Queues.EventSourceLive>
  | Layer.Success<typeof Cloudflare.Workers.CronEventSourceLive>;

export default layer;
