import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as SecureRandom from "effect/crypto/SecureRandom";

import type * as RelayDb from "../db.ts";
import * as HookForwarder from "../hooks/HookForwarder.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as MobileTelemetry from "../mobileTelemetry/MobileTelemetry.ts";
import * as Ports from "./ports.ts";
import type { RelayHost } from "./RelayHost.ts";

/**
 * TLS ends at the proxy, so the Node request is plain HTTP. DPoP proofs sign the public URL,
 * so every request is rewritten to the configured origin instead of trusting forwarded headers.
 */
export const withPublicOrigin = (relayPublicOrigin: string) => {
  const origin = new URL(relayPublicOrigin);
  const protocol = origin.protocol === "https:" ? "https" : "http";
  return <A, E, R>(handler: Effect.Effect<A, E, R>) =>
    Effect.updateService(handler, HttpServerRequest.HttpServerRequest, (request) =>
      request.modify({ protocol, headers: Headers.set(request.headers, "host", origin.host) }),
    );
};

export interface NodeHostOptions {
  readonly relayPublicOrigin: string;
  readonly stage: string;
  readonly channelHost?: string | undefined;
  readonly mintKeyPair: {
    readonly privateKey: Redacted.Redacted<string>;
    readonly publicKey: string;
  };
  /** Stable signing secret shared by every relay replica. */
  readonly apnsJobSigningSecret?: Redacted.Redacted<string>;
  readonly database: RelayDb.RelayDb["Service"];
  /** Base URLs of an Axiom-compatible ingest; empty disables mobile telemetry forwarding. */
  readonly mobileTelemetry: {
    readonly token: Redacted.Redacted<string> | undefined;
    readonly traces: string;
    readonly logs: string;
    readonly metrics: string;
  };
}

interface QueuedJob {
  readonly body: unknown;
  readonly attempts: number;
}

// Self-hosted relay: queues and rate limits live in this process, so pending pushes do not
// survive a restart. Cron supports only `*/N * * * *`, the one schedule the relay uses.
const MINUTE_STEP_CRON = /^\*\/(\d+) \* \* \* \*$/;

export const fixedWindowLimit = (limit: number, periodSeconds: number) => {
  const windows = new Map<string, { readonly windowStart: number; count: number }>();
  const periodMillis = periodSeconds * 1000;
  return (key: string): Effect.Effect<boolean> =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      if (windows.size > 10_000) {
        for (const [windowKey, window] of windows) {
          if (now - window.windowStart >= periodMillis) windows.delete(windowKey);
        }
      }
      const window = windows.get(key);
      if (window === undefined || now - window.windowStart >= periodMillis) {
        windows.set(key, { windowStart: now, count: 1 });
        return true;
      }
      window.count += 1;
      return window.count <= limit;
    });
};

const inertTunnelClient: ManagedEndpointProvider.ManagedEndpointTunnelClient["Service"] = {
  get: (tunnelId) =>
    Effect.fail(
      new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
        operation: "get",
        tunnelId,
        cause: "managed tunnels are not available on this relay",
      }),
    ),
  list: () => Effect.succeed({ result: [], resultInfo: null }),
  create: (request) =>
    Effect.fail(
      new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
        operation: "create",
        tunnelName: request.name,
        cause: "managed tunnels are not available on this relay",
      }),
    ),
  putConfiguration: (tunnelId) =>
    Effect.fail(
      new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
        operation: "put-configuration",
        tunnelId,
        cause: "managed tunnels are not available on this relay",
      }),
    ),
  getConfiguration: (tunnelId) =>
    Effect.fail(
      new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
        operation: "get-configuration",
        tunnelId,
        cause: "managed tunnels are not available on this relay",
      }),
    ),
  getToken: (tunnelId) =>
    Effect.fail(
      new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
        operation: "get-token",
        tunnelId,
        cause: "managed tunnels are not available on this relay",
      }),
    ),
  delete: () => Effect.void,
};

const inertDnsClient: ManagedEndpointProvider.ManagedEndpointDnsClient["Service"] = {
  listRecords: () => Effect.succeed([]),
  createRecord: (request) =>
    Effect.fail(
      new ManagedEndpointProvider.ManagedEndpointDnsClientError({
        operation: "create-record",
        hostname: request.name,
        cause: "managed tunnels are not available on this relay",
      }),
    ),
  updateRecord: (dnsRecordId) =>
    Effect.fail(
      new ManagedEndpointProvider.ManagedEndpointDnsClientError({
        operation: "update-record",
        dnsRecordId,
        cause: "managed tunnels are not available on this relay",
      }),
    ),
  deleteRecord: () => Effect.void,
};

const inertHookInbox = Layer.succeed(HookInbox.HookInbox, {
  // Holding webhooks while an environment is offline needs the Cloudflare Durable Object inbox.
  hold: Effect.fn("HookInbox.hold")(() => Effect.succeed(false)),
  wake: Effect.fn("HookInbox.wake")(() => Effect.succeed(false)),
  clear: Effect.fn("HookInbox.clear")(() => Effect.void),
});

/**
 * Builds the self-hosted `RelayHost`. Background work (queue consumers, cron) runs as scoped
 * fibers, so the caller's scope owns it.
 */
export const makeNodeHost = Effect.fn("relay.node.host")(function* (options: NodeHostOptions) {
  const random = yield* SecureRandom.SecureRandom;
  const apnsQueue = yield* Queue.unbounded<QueuedJob>();
  const fcmQueue = yield* Queue.unbounded<QueuedJob>();
  const queueFor = (name: "apns" | "fcm") => (name === "apns" ? apnsQueue : fcmQueue);

  const senderFor = (queue: Queue.Queue<QueuedJob>): Ports.DeliveryQueueSender<unknown> => ({
    send: (body) => Queue.offer(queue, { body, attempts: 0 }).pipe(Effect.asVoid),
  });

  const hookLimit = fixedWindowLimit(
    HookForwarder.RELAY_HOOK_RATE_LIMIT.limit,
    HookForwarder.RELAY_HOOK_RATE_LIMIT.periodSeconds,
  );
  const hookEndpointLimit = fixedWindowLimit(
    HookForwarder.RELAY_HOOK_ENDPOINT_RATE_LIMIT.limit,
    HookForwarder.RELAY_HOOK_ENDPOINT_RATE_LIMIT.periodSeconds,
  );
  const mobileTelemetryLimit = fixedWindowLimit(
    MobileTelemetry.MOBILE_TELEMETRY_RATE_LIMIT.limit,
    MobileTelemetry.MOBILE_TELEMETRY_RATE_LIMIT.periodSeconds,
  );

  const host: RelayHost<Scope.Scope> = {
    deployment: { relayPublicOrigin: options.relayPublicOrigin, stage: options.stage },
    mintKeyPair: Effect.succeed(options.mintKeyPair),
    apnsJobSigningSecret:
      options.apnsJobSigningSecret === undefined
        ? Effect.map(random.randomBytes(32), (bytes) =>
            Redacted.make(Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")),
          )
        : Effect.succeed(options.apnsJobSigningSecret),
    managedEndpointBaseDomain: undefined,
    channelHost: options.channelHost,
    database: options.database,
    managedEndpointClients: Layer.mergeAll(
      Layer.succeed(ManagedEndpointProvider.ManagedEndpointTunnelClient, inertTunnelClient),
      Layer.succeed(ManagedEndpointProvider.ManagedEndpointDnsClient, inertDnsClient),
    ),
    hookInbox: inertHookInbox,
    rateLimits: {
      hook: hookLimit,
      hookEndpoint: hookEndpointLimit,
      mobileTelemetry: mobileTelemetryLimit,
    },
    mobileTelemetry: {
      settings: Effect.succeed(
        MobileTelemetry.MobileTelemetrySettings.of({
          axiomToken: options.mobileTelemetry.token ?? Redacted.make(""),
          destinations: {
            traces: { url: options.mobileTelemetry.traces, dataset: "" },
            logs: { url: options.mobileTelemetry.logs, dataset: "" },
            metrics: { url: options.mobileTelemetry.metrics, dataset: "" },
          },
        }),
      ),
      sourceMaps: Effect.succeed({
        get: Effect.fn("SourceMapObjects.get")(() => Effect.undefined),
      }),
    },
    apnsSender: Effect.succeed(senderFor(apnsQueue)),
    fcmSender: Effect.succeed(senderFor(fcmQueue)),
    consumeQueue: (name, consumerOptions, handler) => {
      const queue = queueFor(name);
      const deliver = (job: QueuedJob) =>
        handler(job.body).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
            const attempts = job.attempts + 1;
            if (attempts >= consumerOptions.maxRetries) {
              return Effect.logWarning("Dropping relay delivery job after retries", {
                queue: name,
                attempts,
              });
            }
            return Effect.logWarning("Retrying relay delivery job", { queue: name, attempts }).pipe(
              Effect.andThen(
                Effect.forkScoped(
                  Effect.sleep(consumerOptions.retryDelay).pipe(
                    Effect.andThen(Queue.offer(queue, { body: job.body, attempts })),
                  ),
                ),
              ),
            );
          }),
        );
      return Queue.take(queue).pipe(
        Effect.flatMap(deliver),
        Effect.forever,
        Effect.forkScoped,
        Effect.asVoid,
      );
    },
    schedule: (cron, effect) => {
      const match = MINUTE_STEP_CRON.exec(cron);
      if (match === null) {
        return Effect.die(new Error(`Unsupported cron schedule on a self-hosted relay: ${cron}`));
      }
      const every = Duration.minutes(Number(match[1]));
      return Effect.forkScoped(
        Effect.forever(Effect.sleep(every).pipe(Effect.andThen(effect))),
      ).pipe(Effect.asVoid);
    },
  };
  return host;
});
