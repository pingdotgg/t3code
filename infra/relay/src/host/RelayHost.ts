import type * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";

import type * as CloudflareApiPause from "../environments/CloudflareApiPause.ts";
import type * as RelayDb from "../db.ts";
import type * as HookInbox from "../hooks/HookInbox.ts";
import type * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import type * as MobileTelemetry from "../mobileTelemetry/MobileTelemetry.ts";
import type * as Ports from "./ports.ts";
import type { SignedApnsDeliveryJob } from "../agentActivity/apnsDeliveryJobs.ts";
import type { FcmDeliveryJob } from "../agentActivity/FcmDeliveries.ts";

/**
 * Everything the relay needs from its platform. `composition.ts` is platform-neutral; `worker.ts`
 * (Cloudflare) and `node.ts` (self-hosted) each build one of these.
 *
 * `R` is whatever the host's background work (queue consumers, cron) needs from its runtime.
 */
export interface RelayHost<R = never> {
  readonly deployment: {
    readonly relayPublicOrigin: string;
    readonly stage: string;
  };
  /** Relay-signed mint keys; every replica must see the same pair. */
  readonly mintKeyPair: Effect.Effect<{
    readonly privateKey: Redacted.Redacted<string>;
    readonly publicKey: string;
  }>;
  readonly apnsJobSigningSecret: Effect.Effect<Redacted.Redacted<string>>;
  /** Managed tunnel base domain; undefined disables managed endpoints. */
  readonly managedEndpointBaseDomain: string | undefined;
  readonly database: RelayDb.RelayDb["Service"];
  /** Tunnel and DNS clients behind managed endpoints; inert on hosts without managed tunnels. */
  readonly managedEndpointClients: Layer.Layer<
    | ManagedEndpointProvider.ManagedEndpointTunnelClient
    | ManagedEndpointProvider.ManagedEndpointDnsClient,
    never,
    CloudflareApiPause.CloudflareApiPause | HttpClient.HttpClient
  >;
  readonly hookInbox: Layer.Layer<HookInbox.HookInbox>;
  /** Each limiter may fail; the composition decides to fail open. */
  readonly rateLimits: {
    readonly hook: (key: string) => Effect.Effect<boolean, Ports.RateLimitUnavailableError>;
    readonly hookEndpoint: (key: string) => Effect.Effect<boolean, Ports.RateLimitUnavailableError>;
    readonly mobileTelemetry: (
      key: string,
    ) => Effect.Effect<boolean, Ports.RateLimitUnavailableError>;
  };
  readonly mobileTelemetry: {
    readonly settings: Effect.Effect<MobileTelemetry.MobileTelemetrySettings["Service"]>;
    readonly sourceMaps: Effect.Effect<MobileTelemetry.SourceMapObjects["Service"]>;
  };
  readonly apnsSender: Effect.Effect<Ports.DeliveryQueueSender<SignedApnsDeliveryJob>>;
  readonly fcmSender: Effect.Effect<Ports.DeliveryQueueSender<FcmDeliveryJob>>;
  /** A failing handler asks the host to retry that message; the host owns retries and dead-lettering. */
  readonly consumeQueue: (
    name: "apns" | "fcm",
    options: Omit<Ports.DeliveryQueueConsumerOptions, "deadLetterQueue">,
    handler: (body: unknown) => Effect.Effect<void, Ports.QueueHandlerError, HttpClient.HttpClient>,
  ) => Effect.Effect<void, never, R | HttpClient.HttpClient>;
  /** Runs `effect` on the cron schedule; the host owns retries and overlap policy. */
  readonly schedule: (
    cron: string,
    effect: Effect.Effect<void, never, HttpClient.HttpClient>,
  ) => Effect.Effect<void, never, R | HttpClient.HttpClient>;
}
