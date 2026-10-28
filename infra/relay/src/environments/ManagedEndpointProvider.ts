import * as CloudflareRetry from "@distilled.cloud/cloudflare/Retry";
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  RelayManagedEndpoint,
  RelayManagedEndpointOrigin,
  RelayManagedEndpointRuntimeConfig,
} from "@t3tools/contracts/relay";

import * as RelayConfiguration from "../Config.ts";
import {
  managedEndpointDigestInput,
  managedEndpointForHostname,
  managedEndpointHostname,
  managedEndpointTunnelName,
} from "../deploymentConfig.ts";
import * as CloudflareApiPause from "./CloudflareApiPause.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

export class ManagedEndpointProvisioningNotConfigured extends Schema.TaggedError<ManagedEndpointProvisioningNotConfigured>()(
  "ManagedEndpointProvisioningNotConfigured",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    missingSettings: Schema.Array(
      Schema.Literals(["managedEndpointBaseDomain", "managedEndpointNamespace"]),
    ),
  },
) {
  override get message(): string {
    return `Managed endpoint provisioning is not configured for user '${this.userId}', environment '${this.environmentId}': missing ${this.missingSettings.join(", ")}`;
  }
}

const ManagedEndpointProvisioningStage = Schema.Literals([
  "derive-environment-hash",
  "check-tunnel-limit",
  "reserve-allocation",
  "ensure-tunnel",
  "validate-tunnel-response",
  "record-tunnel",
  "configure-tunnel",
  "ensure-dns-record",
  "record-dns",
  "get-tunnel-token",
  "mark-allocation-ready",
  "load-allocation",
  "verify-endpoint",
  "verify-tunnel",
  "sync-origin",
]);

const ManagedEndpointProvisioningFailureReason = Schema.Literals([
  "claim-lost",
  "endpoint-mismatch",
  "invalid-tunnel-response",
]);

export class ManagedEndpointProvisioningFailed extends Schema.TaggedError<ManagedEndpointProvisioningFailed>()(
  "ManagedEndpointProvisioningFailed",
  {
    stage: ManagedEndpointProvisioningStage,
    reason: Schema.optionalKey(ManagedEndpointProvisioningFailureReason),
    userId: Schema.String,
    environmentId: Schema.String,
    hostname: Schema.optionalKey(Schema.String),
    tunnelName: Schema.optionalKey(Schema.String),
    tunnelId: Schema.optionalKey(Schema.String),
    dnsRecordId: Schema.optionalKey(Schema.String),
    returnedTunnelName: Schema.optionalKey(Schema.String),
    returnedTunnelId: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Managed endpoint provisioning failed during '${this.stage}' for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

const ManagedEndpointDeprovisioningStage = Schema.Literals([
  "load-allocation",
  "load-tunnel",
  "claim-release",
  "claim-deprovision",
  "delete-dns-record",
  "delete-tunnel",
  "remove-allocation",
]);

export class ManagedEndpointDeprovisioningFailed extends Schema.TaggedError<ManagedEndpointDeprovisioningFailed>()(
  "ManagedEndpointDeprovisioningFailed",
  {
    stage: ManagedEndpointDeprovisioningStage,
    userId: Schema.String,
    environmentId: Schema.String,
    tunnelId: Schema.optionalKey(Schema.String),
    dnsRecordId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Managed endpoint deprovisioning failed during '${this.stage}' for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class ManagedEndpointOriginNotAllowed extends Schema.TaggedError<ManagedEndpointOriginNotAllowed>()(
  "ManagedEndpointOriginNotAllowed",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    host: Schema.String,
    port: Schema.Number,
  },
) {
  override get message(): string {
    return `Managed endpoint origin '${this.host}:${this.port}' is not allowed for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export type ManagedEndpointProviderError =
  | ManagedEndpointProvisioningNotConfigured
  | ManagedEndpointProvisioningFailed
  | ManagedEndpointOriginNotAllowed
  | ManagedTunnelLimits.ManagedTunnelLimitExceeded;

export interface ManagedEndpointProvisioningResult {
  readonly endpoint: RelayManagedEndpoint;
  readonly runtime: RelayManagedEndpointRuntimeConfig;
}

export type ManagedEndpointOriginSyncResult = "ready" | "recovery_required";

export type ManagedEndpointDeprovisionTarget = ManagedEndpointAllocations.ManagedEndpointAllocation;

export class ManagedEndpointProvider extends Context.Service<
  ManagedEndpointProvider,
  {
    readonly provision: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly origin: RelayManagedEndpointOrigin;
      /**
       * Return a ready tunnel that already serves this origin with only a
       * liveness check and a fresh token, skipping ingress and DNS repair.
       */
      readonly reuseReadyTunnel?: boolean;
    }) => Effect.Effect<ManagedEndpointProvisioningResult, ManagedEndpointProviderError>;
    readonly reconcileOrigin: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly tunnelId: string;
      readonly origin: RelayManagedEndpointOrigin;
      readonly endpoint: RelayManagedEndpoint;
    }) => Effect.Effect<ManagedEndpointOriginSyncResult, ManagedEndpointProviderError>;
    /** Capture before revocation so a concurrent relink's newer allocation survives deprovision. */
    readonly prepareDeprovision: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<
      ManagedEndpointDeprovisionTarget | null,
      ManagedEndpointDeprovisioningFailed
    >;
    readonly deprovision: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly target?: ManagedEndpointDeprovisionTarget | null;
    }) => Effect.Effect<boolean, ManagedEndpointDeprovisioningFailed>;
    /** True means the connector token is dead; false means concurrent provisioning kept its tunnel live. */
    readonly release: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly expectedTunnelId?: string;
      readonly expectedInactiveBefore?: string;
      readonly expectedStatus?: "inactive" | "down";
      readonly markReleased?: boolean;
    }) => Effect.Effect<boolean, ManagedEndpointDeprovisioningFailed>;
  }
>()("t3code-relay/environments/ManagedEndpointProvider") {}

export interface ManagedEndpointTunnel {
  readonly id?: string | null;
  readonly name?: string | null;
  readonly status?: string | null;
  readonly createdAt?: string | null;
  readonly connsInactiveAt?: string | null;
  readonly deletedAt?: string | null;
}

export interface ManagedEndpointTunnelListRequest {
  readonly isDeleted: false;
  readonly name?: string;
  readonly includePrefix?: string;
  readonly status?: "inactive" | "down";
  readonly existedAt?: string;
  readonly wasInactiveAt?: string;
  readonly page?: number;
  readonly perPage?: number;
}

const ManagedEndpointTunnelClientOperation = Schema.Literals([
  "get",
  "list",
  "create",
  "put-configuration",
  "get-token",
  "delete",
]);

export class ManagedEndpointTunnelClientError extends Schema.TaggedError<ManagedEndpointTunnelClientError>()(
  "ManagedEndpointTunnelClientError",
  {
    operation: ManagedEndpointTunnelClientOperation,
    tunnelName: Schema.optionalKey(Schema.String),
    tunnelId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const target = this.tunnelId ?? this.tunnelName;
    return `Managed endpoint tunnel provider '${this.operation}' request failed${target === undefined ? "" : ` for '${target}'`}`;
  }
}

export class ManagedEndpointTunnelClient extends Context.Service<
  ManagedEndpointTunnelClient,
  {
    readonly get: (
      tunnelId: string,
    ) => Effect.Effect<ManagedEndpointTunnel, ManagedEndpointTunnelClientError>;
    readonly list: (request: ManagedEndpointTunnelListRequest) => Effect.Effect<
      {
        readonly result: ReadonlyArray<ManagedEndpointTunnel>;
        readonly resultInfo?: {
          readonly page?: number | null;
          readonly perPage?: number | null;
          readonly totalCount?: number | null;
        } | null;
      },
      ManagedEndpointTunnelClientError
    >;
    readonly create: (request: {
      readonly name: string;
      readonly configSrc: "cloudflare";
    }) => Effect.Effect<ManagedEndpointTunnel, ManagedEndpointTunnelClientError>;
    readonly putConfiguration: (
      tunnelId: string,
      config: {
        readonly ingress: Array<{
          readonly hostname?: string;
          readonly service: string;
        }>;
      },
    ) => Effect.Effect<unknown, ManagedEndpointTunnelClientError>;
    readonly getToken: (
      tunnelId: string,
    ) => Effect.Effect<string, ManagedEndpointTunnelClientError>;
    readonly delete: (tunnelId: string) => Effect.Effect<unknown, ManagedEndpointTunnelClientError>;
  }
>()("t3code-relay/environments/ManagedEndpointProvider/ManagedEndpointTunnelClient") {}

export const layerTunnelClient = (client: ManagedEndpointTunnelClient["Service"]) =>
  Layer.succeed(ManagedEndpointTunnelClient, client);

interface ManagedEndpointCnameRecordInput {
  readonly type: "CNAME";
  readonly name: string;
  readonly content: string;
  readonly ttl: 1;
  readonly proxied: true;
}

const ManagedEndpointDnsClientOperation = Schema.Literals([
  "list-records",
  "create-record",
  "update-record",
  "delete-record",
]);

export class ManagedEndpointDnsClientError extends Schema.TaggedError<ManagedEndpointDnsClientError>()(
  "ManagedEndpointDnsClientError",
  {
    operation: ManagedEndpointDnsClientOperation,
    hostname: Schema.optionalKey(Schema.String),
    dnsRecordId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const target = this.dnsRecordId ?? this.hostname;
    return `Managed endpoint DNS provider '${this.operation}' request failed${target === undefined ? "" : ` for '${target}'`}`;
  }
}

export class ManagedEndpointDnsClient extends Context.Service<
  ManagedEndpointDnsClient,
  {
    readonly listRecords: (
      hostname: string,
    ) => Effect.Effect<ReadonlyArray<{ readonly id: string }>, ManagedEndpointDnsClientError>;
    readonly createRecord: (
      request: ManagedEndpointCnameRecordInput,
    ) => Effect.Effect<{ readonly id: string }, ManagedEndpointDnsClientError>;
    readonly updateRecord: (
      dnsRecordId: string,
      request: ManagedEndpointCnameRecordInput,
    ) => Effect.Effect<unknown, ManagedEndpointDnsClientError>;
    readonly deleteRecord: (
      dnsRecordId: string,
    ) => Effect.Effect<unknown, ManagedEndpointDnsClientError>;
  }
>()("t3code-relay/environments/ManagedEndpointProvider/ManagedEndpointDnsClient") {}

export const layerDnsClient = (client: ManagedEndpointDnsClient["Service"]) =>
  Layer.succeed(ManagedEndpointDnsClient, client);

const requireCloudflareSettings = Effect.fnUntraced(function* (
  settings: RelayConfiguration.RelayConfiguration["Service"],
  input: { readonly userId: string; readonly environmentId: string },
) {
  const baseDomain = settings.managedEndpointBaseDomain;
  const namespace = settings.managedEndpointNamespace;
  const missingSettings: Array<"managedEndpointBaseDomain" | "managedEndpointNamespace"> = [];
  if (!baseDomain) {
    missingSettings.push("managedEndpointBaseDomain");
  }
  if (!namespace) {
    missingSettings.push("managedEndpointNamespace");
  }
  if (!baseDomain || !namespace) {
    return yield* new ManagedEndpointProvisioningNotConfigured({
      ...input,
      missingSettings,
    });
  }
  return {
    baseDomain,
    namespace,
  };
});

function formatOriginService(origin: RelayManagedEndpointOrigin): string {
  const host = origin.localHttpHost.includes(":")
    ? `[${origin.localHttpHost.replace(/^\[(.*)\]$/u, "$1")}]`
    : origin.localHttpHost;
  return `http://${host}:${origin.localHttpPort}`;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/\.$/u, "")
    .replace(/^\[(.*)\]$/u, "$1");
}

function isLoopbackOrigin(origin: RelayManagedEndpointOrigin): boolean {
  const hostname = normalizeHostname(origin.localHttpHost);
  return (
    (hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost") &&
    Number.isInteger(origin.localHttpPort) &&
    origin.localHttpPort > 0 &&
    origin.localHttpPort <= 65_535
  );
}

function isManagedEndpointNotFound(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }
  if ("_tag" in cause && (cause._tag === "NotFound" || cause._tag === "TunnelNotFound")) {
    return true;
  }
  if ("status" in cause && cause.status === 404) {
    return true;
  }
  return "cause" in cause && isManagedEndpointNotFound(cause.cause);
}

export class CloudflareApiPaused extends Schema.TaggedError<CloudflareApiPaused>()(
  "CloudflareApiPaused",
  { retryAfterMillis: Schema.Number },
) {
  override get message(): string {
    return `Cloudflare API calls are paused for ${this.retryAfterMillis}ms after a rate limit`;
  }
}

export function isCloudflareRateLimited(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }
  if (
    "_tag" in cause &&
    (cause._tag === "TooManyRequests" ||
      cause._tag === "CloudflareRateLimited" ||
      cause._tag === "CloudflareApiPaused")
  ) {
    return true;
  }
  if ("status" in cause && cause.status === 429) {
    return true;
  }
  return "cause" in cause && isCloudflareRateLimited(cause.cause);
}

const CLOUDFLARE_DEFAULT_RATE_LIMIT_PAUSE = Duration.seconds(30);
const CLOUDFLARE_MAX_RATE_LIMIT_PAUSE = Duration.minutes(2);

function cloudflareRateLimitPauseMillis(cause: unknown): number {
  const retryAfter =
    typeof cause === "object" && cause !== null && "retryAfter" in cause
      ? cause.retryAfter
      : undefined;
  const pause = Duration.isDuration(retryAfter) ? retryAfter : CLOUDFLARE_DEFAULT_RATE_LIMIT_PAUSE;
  return Duration.toMillis(Duration.min(pause, CLOUDFLARE_MAX_RATE_LIMIT_PAUSE));
}

/**
 * How long a caller should wait before retrying, when `cause` is a Cloudflare
 * rate limit or a call refused during the pause that follows one.
 */
export function cloudflareRetryAfterMillis(cause: unknown): number | undefined {
  for (let current = cause, depth = 0; depth < 8; depth++) {
    if (typeof current !== "object" || current === null) return undefined;
    if ("_tag" in current && current._tag === "CloudflareApiPaused") {
      const retryAfterMillis: unknown = Reflect.get(current, "retryAfterMillis");
      return typeof retryAfterMillis === "number" ? retryAfterMillis : undefined;
    }
    if (
      ("_tag" in current &&
        (current._tag === "TooManyRequests" || current._tag === "CloudflareRateLimited")) ||
      ("status" in current && current.status === 429)
    ) {
      return cloudflareRateLimitPauseMillis(current);
    }
    if (!("cause" in current)) return undefined;
    current = current.cause;
  }
  return undefined;
}

// The SDK's default policy sleeps through Retry-After inside the request, which
// held every caller until its timeout and kept the account over its limit.
// Rate limits surface at once instead; other transient failures still retry.
const withoutRateLimitRetries: CloudflareRetry.Factory = (lastError) => {
  const defaults = CloudflareRetry.makeDefault(lastError);
  return {
    ...defaults,
    while: (error) => !isCloudflareRateLimited(error) && (defaults.while?.(error) ?? false),
  };
};

// Every isolate rereads the shared pause at most this often, so a quiet
// period costs one query per isolate rather than one per Cloudflare call.
const CLOUDFLARE_PAUSE_REFRESH_MILLIS = 5_000;

/**
 * The rate limit is account-wide, so once one call is rejected every other
 * call is too, from any isolate. Failing them without a request leaves the
 * account room to recover instead of extending the limit.
 */
const makeCloudflareApiGate = (alchemyRuntimeContext: Alchemy.BaseRuntimeContext) => {
  let pausedUntilMillis = 0;
  let checkedAtMillis = Number.NEGATIVE_INFINITY;
  return (pause: CloudflareApiPause.CloudflareApiPause["Service"]) => {
    const recordRateLimit = Effect.fn("relay.cloudflare_api_pause.rate_limited")(function* (
      cause: unknown,
    ) {
      const pauseMillis = cloudflareRateLimitPauseMillis(cause);
      const until = (yield* Clock.currentTimeMillis) + pauseMillis;
      pausedUntilMillis = Math.max(pausedUntilMillis, until);
      yield* Effect.annotateCurrentSpan({ "relay.cloudflare.pause_ms": pauseMillis });
      yield* pause.pauseUntil(until);
    });
    return <A, E>(
      call: Effect.Effect<A, E, Alchemy.RuntimeContext>,
    ): Effect.Effect<A, E | CloudflareApiPaused | Cause.TimeoutError> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now >= pausedUntilMillis && now - checkedAtMillis >= CLOUDFLARE_PAUSE_REFRESH_MILLIS) {
          checkedAtMillis = now;
          // Read first: a 429 recorded while the read is in flight must win.
          const shared = yield* pause.pausedUntilMillis;
          pausedUntilMillis = Math.max(pausedUntilMillis, shared);
        }
        // A paused call never reaches Cloudflare, so it leaves no 429 behind.
        // Its own span keeps a storm visible to the rate-limit monitors.
        if (now < pausedUntilMillis) {
          return yield* new CloudflareApiPaused({ retryAfterMillis: pausedUntilMillis - now }).pipe(
            Effect.withSpan("relay.cloudflare_api_pause.rejected"),
          );
        }
        return yield* call.pipe(
          Effect.provideService(CloudflareRetry.Retry, withoutRateLimitRetries),
          Effect.timeout("8 seconds"),
          Effect.tapError((cause) =>
            isCloudflareRateLimited(cause) ? recordRateLimit(cause) : Effect.void,
          ),
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
        );
      });
  };
};

/**
 * Cloudflare refuses to delete a tunnel while a connector is still attached,
 * either one that has not finished draining or another runtime still serving
 * the tunnel.
 */
function isManagedEndpointTunnelInUse(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }
  if (
    "message" in cause &&
    typeof cause.message === "string" &&
    cause.message.includes("has active connections")
  ) {
    return true;
  }
  return "cause" in cause && isManagedEndpointTunnelInUse(cause.cause);
}

type ManagedEndpointClientError = ManagedEndpointTunnelClientError | ManagedEndpointDnsClientError;

const ignoreNotFound = <A>(
  effect: Effect.Effect<A, ManagedEndpointClientError>,
): Effect.Effect<void, ManagedEndpointClientError> =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchTags({
      ManagedEndpointTunnelClientError: (error) =>
        isManagedEndpointNotFound(error.cause) ? Effect.void : Effect.fail(error),
      ManagedEndpointDnsClientError: (error) =>
        isManagedEndpointNotFound(error.cause) ? Effect.void : Effect.fail(error),
    }),
  );

const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const crypto = yield* Crypto.Crypto;
  const tunnels = yield* ManagedEndpointTunnelClient;
  const dns = yield* ManagedEndpointDnsClient;
  const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
  const tunnelLimits = yield* ManagedTunnelLimits.ManagedTunnelLimits;

  const updateExistingDnsRecords = Effect.fnUntraced(function* (
    records: ReadonlyArray<{ readonly id: string }>,
    preferredDnsRecordId: string | null,
    dnsRecord: ManagedEndpointCnameRecordInput,
  ) {
    const keptRecord = records.find((record) => record.id === preferredDnsRecordId) ?? records[0];
    if (keptRecord === undefined) {
      return null;
    }
    yield* Effect.forEach(
      records,
      (record) => (record.id === keptRecord.id ? Effect.void : dns.deleteRecord(record.id)),
      { discard: true },
    );
    yield* dns.updateRecord(keptRecord.id, dnsRecord);
    return keptRecord.id;
  });

  const ensureDnsRecord = Effect.fnUntraced(function* (
    hostname: string,
    preferredDnsRecordId: string | null,
    dnsRecord: ManagedEndpointCnameRecordInput,
  ) {
    if (preferredDnsRecordId !== null) {
      const checkpointedRecordUpdated = yield* dns
        .updateRecord(preferredDnsRecordId, dnsRecord)
        .pipe(
          Effect.as(true),
          Effect.catchTags({
            ManagedEndpointDnsClientError: (error) =>
              isManagedEndpointNotFound(error.cause) ? Effect.succeed(false) : Effect.fail(error),
          }),
        );
      if (checkpointedRecordUpdated) {
        return preferredDnsRecordId;
      }
    }
    const existingDnsRecords = yield* dns.listRecords(hostname);
    const existingDnsRecordId = yield* updateExistingDnsRecords(
      existingDnsRecords,
      preferredDnsRecordId,
      dnsRecord,
    );
    if (existingDnsRecordId !== null) {
      return existingDnsRecordId;
    }
    return yield* dns.createRecord(dnsRecord).pipe(
      Effect.map((record) => record.id),
      Effect.catchTags({
        ManagedEndpointDnsClientError: (createError) =>
          Effect.gen(function* () {
            let records = yield* dns.listRecords(hostname);
            for (let attempt = 0; records.length === 0 && attempt < 4; attempt++) {
              yield* Effect.sleep("200 millis");
              records = yield* dns.listRecords(hostname);
            }
            return records;
          }).pipe(
            Effect.flatMap((records) =>
              records.length > 0
                ? updateExistingDnsRecords(records, preferredDnsRecordId, dnsRecord)
                : Effect.fail(createError),
            ),
            Effect.filterOrFail(
              (dnsRecordId) => dnsRecordId !== null,
              () => createError,
            ),
          ),
      }),
    );
  });

  // Hosts ask for recovery whenever their connector cannot register, mostly
  // for local reasons a fresh provision cannot fix. Those requests outnumber
  // every other Cloudflare caller, so a tunnel that is ready for the same
  // origin costs two reads instead of a full provision.
  const reuseReadyTunnel = Effect.fnUntraced(function* (
    allocation: ManagedEndpointAllocations.ManagedEndpointAllocation,
    origin: RelayManagedEndpointOrigin,
  ) {
    const { tunnelId } = allocation;
    if (
      tunnelId === null ||
      allocation.readyAt === null ||
      allocation.dnsRecordId === null ||
      allocation.tunnelReleasedAt !== null ||
      allocation.origin?.localHttpHost !== origin.localHttpHost ||
      allocation.origin.localHttpPort !== origin.localHttpPort
    ) {
      return Option.none<ManagedEndpointProvisioningResult>();
    }
    const failed = (
      stage: "verify-tunnel" | "get-tunnel-token",
      cause: ManagedEndpointTunnelClientError,
    ) =>
      new ManagedEndpointProvisioningFailed({
        userId: allocation.userId,
        environmentId: allocation.environmentId,
        stage,
        hostname: allocation.hostname,
        tunnelName: allocation.tunnelName,
        tunnelId,
        cause,
      });
    const recorded = yield* tunnels.get(tunnelId).pipe(
      Effect.asSome,
      Effect.catchTags({
        ManagedEndpointTunnelClientError: (cause) =>
          isManagedEndpointNotFound(cause.cause)
            ? Effect.succeedNone
            : Effect.fail(failed("verify-tunnel", cause)),
      }),
    );
    if (Option.isNone(recorded) || recorded.value.deletedAt) {
      return Option.none<ManagedEndpointProvisioningResult>();
    }
    const connectorToken = yield* tunnels
      .getToken(tunnelId)
      .pipe(Effect.mapError((cause) => failed("get-tunnel-token", cause)));
    yield* Effect.annotateCurrentSpan({ "relay.managed_endpoint.reused_ready_tunnel": true });
    return Option.some<ManagedEndpointProvisioningResult>({
      endpoint: managedEndpointForHostname(allocation.hostname),
      runtime: {
        providerKind: "cloudflare_tunnel",
        connectorToken,
        tunnelId,
        tunnelName: allocation.tunnelName,
      },
    });
  });

  const prepareDeprovision = Effect.fn("relay.managed_endpoint_provider.prepare_deprovision")(
    function* (input: { readonly userId: string; readonly environmentId: string }) {
      return yield* allocations.get(input).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedEndpointDeprovisioningFailed({
              ...input,
              stage: "load-allocation",
              cause,
            }),
        ),
      );
    },
  );

  const reconcileOrigin = Effect.fn("relay.managed_endpoint_provider.reconcile_origin")(
    function* (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly tunnelId: string;
      readonly origin: RelayManagedEndpointOrigin;
      readonly endpoint: RelayManagedEndpoint;
    }) {
      if (!isLoopbackOrigin(input.origin)) {
        return yield* new ManagedEndpointOriginNotAllowed({
          userId: input.userId,
          environmentId: input.environmentId,
          host: input.origin.localHttpHost,
          port: input.origin.localHttpPort,
        });
      }
      const allocation = yield* allocations.get(input).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedEndpointProvisioningFailed({
              ...input,
              stage: "load-allocation",
              cause,
            }),
        ),
      );
      if (
        allocation === null ||
        allocation.tunnelId !== input.tunnelId ||
        allocation.dnsRecordId === null ||
        allocation.readyAt === null
      ) {
        return "recovery_required";
      }
      const cf = yield* requireCloudflareSettings(config, input);
      const recordedEndpoint = ManagedEndpointAllocations.resolveReadyManagedEndpoint({
        allocation,
        baseDomain: cf.baseDomain,
      });
      if (
        recordedEndpoint === null ||
        recordedEndpoint.httpBaseUrl !== input.endpoint.httpBaseUrl ||
        recordedEndpoint.wsBaseUrl !== input.endpoint.wsBaseUrl ||
        recordedEndpoint.providerKind !== input.endpoint.providerKind
      ) {
        return yield* new ManagedEndpointProvisioningFailed({
          ...input,
          stage: "verify-endpoint",
          reason: "endpoint-mismatch",
          hostname: allocation.hostname,
        });
      }
      // Released records retain tunnel ids; verify Cloudflare still has the tunnel before reconnecting.
      const recorded = yield* tunnels.get(input.tunnelId).pipe(
        Effect.asSome,
        Effect.catchTags({
          ManagedEndpointTunnelClientError: (cause) =>
            isManagedEndpointNotFound(cause.cause)
              ? Effect.succeedNone
              : Effect.fail(
                  new ManagedEndpointProvisioningFailed({
                    userId: input.userId,
                    environmentId: input.environmentId,
                    stage: "verify-tunnel",
                    tunnelId: input.tunnelId,
                    cause,
                  }),
                ),
        }),
      );
      if (Option.isNone(recorded) || recorded.value.deletedAt) {
        return "recovery_required";
      }
      if (
        allocation.origin?.localHttpHost === input.origin.localHttpHost &&
        allocation.origin.localHttpPort === input.origin.localHttpPort
      ) {
        return "ready";
      }

      const updated = yield* allocations
        .withClaimedTunnel(
          {
            userId: input.userId,
            environmentId: input.environmentId,
            tunnelId: input.tunnelId,
            generation: allocation.generation,
          },
          tunnels
            .putConfiguration(input.tunnelId, {
              ingress: [
                {
                  hostname: allocation.hostname,
                  service: formatOriginService(input.origin),
                },
                { service: "http_status:404" },
              ],
            })
            .pipe(
              Effect.as("configured" as const),
              Effect.catchTags({
                ManagedEndpointTunnelClientError: (error) =>
                  isManagedEndpointNotFound(error.cause)
                    ? Effect.succeed("missing" as const)
                    : Effect.fail(error),
              }),
              Effect.filterOrElse(
                (result): result is "missing" => result === "missing",
                () =>
                  allocations
                    .markReady({
                      ...input,
                      generation: allocation.generation,
                    })
                    .pipe(
                      Effect.map((updated) =>
                        updated ? ("configured" as const) : ("stale" as const),
                      ),
                    ),
              ),
            ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvisioningFailed({
                ...input,
                stage: "sync-origin",
                cause,
              }),
          ),
        );
      if (Option.isNone(updated) || updated.value === "stale") {
        return yield* new ManagedEndpointProvisioningFailed({
          ...input,
          stage: "sync-origin",
          reason: "claim-lost",
        });
      }
      return updated.value === "configured" ? "ready" : "recovery_required";
    },
  );

  return ManagedEndpointProvider.of({
    prepareDeprovision,
    reconcileOrigin,
    deprovision: Effect.fn("relay.managed_endpoint_provider.deprovision")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.user_id": input.userId,
        "relay.environment_id": input.environmentId,
      });
      const allocation =
        input.target === undefined ? yield* prepareDeprovision(input) : input.target;
      if (allocation === null) {
        return true;
      }
      const claimedGeneration = yield* allocations
        .claimDeprovision({
          userId: input.userId,
          environmentId: input.environmentId,
          generation: allocation.generation,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointDeprovisioningFailed({
                ...input,
                stage: "claim-deprovision",
                ...(allocation.tunnelId === null ? {} : { tunnelId: allocation.tunnelId }),
                ...(allocation.dnsRecordId === null ? {} : { dnsRecordId: allocation.dnsRecordId }),
                cause,
              }),
          ),
        );
      if (claimedGeneration === null) {
        return false;
      }
      const tunnelId = allocation.tunnelId;
      const deprovision = Effect.gen(function* () {
        const dnsRecordId = allocation.dnsRecordId;
        if (dnsRecordId !== null) {
          yield* ignoreNotFound(dns.deleteRecord(dnsRecordId)).pipe(
            Effect.mapError(
              (cause) =>
                new ManagedEndpointDeprovisioningFailed({
                  ...input,
                  stage: "delete-dns-record",
                  dnsRecordId,
                  cause,
                }),
            ),
          );
        }
        if (tunnelId !== null) {
          yield* ignoreNotFound(tunnels.delete(tunnelId)).pipe(
            Effect.mapError(
              (cause) =>
                new ManagedEndpointDeprovisioningFailed({
                  ...input,
                  stage: "delete-tunnel",
                  tunnelId,
                  cause,
                }),
            ),
          );
        }
        return yield* allocations
          .removeClaimed({
            userId: input.userId,
            environmentId: input.environmentId,
            generation: claimedGeneration,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ManagedEndpointDeprovisioningFailed({
                  ...input,
                  stage: "remove-allocation",
                  ...(allocation.tunnelId === null ? {} : { tunnelId: allocation.tunnelId }),
                  ...(allocation.dnsRecordId === null
                    ? {}
                    : { dnsRecordId: allocation.dnsRecordId }),
                  cause,
                }),
            ),
          );
      });
      if (tunnelId === null) {
        return yield* deprovision;
      }
      const removed = yield* allocations
        .withClaimedTunnel(
          {
            userId: input.userId,
            environmentId: input.environmentId,
            tunnelId,
            generation: claimedGeneration,
          },
          deprovision,
        )
        .pipe(
          Effect.catchTags({
            ManagedEndpointAllocationPersistenceError: (cause) =>
              Effect.fail(
                new ManagedEndpointDeprovisioningFailed({
                  ...input,
                  stage: "claim-deprovision",
                  tunnelId,
                  cause,
                }),
              ),
          }),
        );
      return Option.getOrElse(removed, () => false);
    }),
    release: Effect.fn("relay.managed_endpoint_provider.release")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.user_id": input.userId,
        "relay.environment_id": input.environmentId,
      });
      const allocation = yield* allocations.get(input).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedEndpointDeprovisioningFailed({
              ...input,
              stage: "load-allocation",
              cause,
            }),
        ),
      );
      const tunnelId = allocation?.tunnelId ?? null;
      if (allocation === null || tunnelId === null) {
        return true;
      }
      if (input.expectedTunnelId !== undefined && input.expectedTunnelId !== tunnelId) {
        return false;
      }
      // Claim before deleting: concurrent provisioning can advance the generation and reuse the tunnel.
      const claimedGeneration = yield* allocations
        .claimRelease({
          userId: input.userId,
          environmentId: input.environmentId,
          tunnelId,
          generation: allocation.generation,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointDeprovisioningFailed({
                ...input,
                stage: "claim-release",
                tunnelId,
                cause,
              }),
          ),
        );
      if (claimedGeneration === null) {
        return false;
      }
      const confirmTunnelGone = (
        failure: ManagedEndpointDeprovisioningFailed,
      ): Effect.Effect<void, ManagedEndpointDeprovisioningFailed> =>
        tunnels.get(tunnelId).pipe(
          Effect.andThen(Effect.fail(failure)),
          Effect.catchTags({
            ManagedEndpointTunnelClientError: (lookupFailure) =>
              isManagedEndpointNotFound(lookupFailure.cause) ? Effect.void : Effect.fail(failure),
          }),
        );
      const deleteTunnel = ignoreNotFound(tunnels.delete(tunnelId)).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedEndpointDeprovisioningFailed({
              ...input,
              stage: "delete-tunnel",
              tunnelId,
              cause,
            }),
        ),
      );
      if (input.expectedInactiveBefore !== undefined && input.expectedStatus !== undefined) {
        const expectedStatus = input.expectedStatus;
        const inactiveBefore = input.expectedInactiveBefore;
        const currentTunnel = yield* tunnels.get(tunnelId).pipe(
          Effect.asSome,
          Effect.catchTags({
            ManagedEndpointTunnelClientError: (cause) =>
              isManagedEndpointNotFound(cause.cause)
                ? Effect.succeedNone
                : Effect.fail(
                    new ManagedEndpointDeprovisioningFailed({
                      ...input,
                      stage: "load-tunnel",
                      tunnelId,
                      cause,
                    }),
                  ),
          }),
        );
        if (Option.isNone(currentTunnel)) {
          return true;
        }
        const inactiveAt =
          expectedStatus === "down"
            ? currentTunnel.value.connsInactiveAt
            : currentTunnel.value.createdAt;
        if (
          currentTunnel.value.id !== tunnelId ||
          currentTunnel.value.status !== expectedStatus ||
          typeof inactiveAt !== "string"
        ) {
          return false;
        }
        const inactiveTime = DateTime.make(inactiveAt);
        const cutoff = DateTime.make(inactiveBefore);
        if (
          Option.isNone(inactiveTime) ||
          Option.isNone(cutoff) ||
          inactiveTime.value.epochMilliseconds > cutoff.value.epochMilliseconds
        ) {
          return false;
        }
      }
      const released = yield* allocations
        .withClaimedTunnel(
          {
            userId: input.userId,
            environmentId: input.environmentId,
            tunnelId,
            generation: claimedGeneration,
          },
          Effect.gen(function* () {
            const finalGeneration = yield* allocations
              .claimRelease({
                userId: input.userId,
                environmentId: input.environmentId,
                tunnelId,
                generation: claimedGeneration,
                ...(input.markReleased === true ? { markReleased: true } : {}),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ManagedEndpointDeprovisioningFailed({
                      ...input,
                      stage: "claim-release",
                      tunnelId,
                      cause,
                    }),
                ),
              );
            if (finalGeneration === null) {
              return false;
            }
            // A timed-out deletion may have succeeded; confirm Cloudflare state before rolling back the claim.
            return yield* deleteTunnel.pipe(
              Effect.as(true),
              Effect.catchIf(
                (error) => isManagedEndpointTunnelInUse(error.cause),
                () => Effect.succeed(false),
              ),
              Effect.catchTags({
                ManagedEndpointDeprovisioningFailed: (failure) =>
                  confirmTunnelGone(failure).pipe(Effect.as(true)),
              }),
            );
          }),
        )
        .pipe(
          Effect.catchTags({
            ManagedEndpointAllocationPersistenceError: (cause) =>
              Effect.fail(
                new ManagedEndpointDeprovisioningFailed({
                  ...input,
                  stage: "claim-release",
                  tunnelId,
                  cause,
                }),
              ),
          }),
        );
      // Keep the allocation recorded so offline environments stay authorized and report offline, not unauthorized.
      return Option.getOrElse(released, () => false);
    }),
    provision: Effect.fn("relay.managed_endpoint_provider.provision")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.user_id": input.userId,
        "relay.environment_id": input.environmentId,
        "relay.managed_endpoint.origin_host": input.origin.localHttpHost,
        "relay.managed_endpoint.origin_port": input.origin.localHttpPort,
      });
      if (!isLoopbackOrigin(input.origin)) {
        return yield* new ManagedEndpointOriginNotAllowed({
          userId: input.userId,
          environmentId: input.environmentId,
          host: input.origin.localHttpHost,
          port: input.origin.localHttpPort,
        });
      }
      const cf = yield* requireCloudflareSettings(config, input);
      const environmentHash = yield* crypto
        .digest(
          "SHA-256",
          new TextEncoder().encode(
            managedEndpointDigestInput(cf.namespace, input.userId, input.environmentId),
          ),
        )
        .pipe(
          Effect.map(Hex.encode),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvisioningFailed({
                userId: input.userId,
                environmentId: input.environmentId,
                stage: "derive-environment-hash",
                cause,
              }),
          ),
        );
      const requestedHostname = managedEndpointHostname(
        cf.namespace,
        cf.baseDomain,
        environmentHash,
      );
      const requestedTunnelName = managedEndpointTunnelName(cf.namespace, environmentHash);
      yield* tunnelLimits
        .ensureCapacity({
          userId: input.userId,
          environmentId: input.environmentId,
        })
        .pipe(
          Effect.catchTags({
            ManagedTunnelLimitPersistenceError: (cause) =>
              Effect.fail(
                new ManagedEndpointProvisioningFailed({
                  userId: input.userId,
                  environmentId: input.environmentId,
                  stage: "check-tunnel-limit",
                  hostname: requestedHostname,
                  tunnelName: requestedTunnelName,
                  cause,
                }),
              ),
          }),
        );
      const allocation = yield* allocations
        .reserve({
          userId: input.userId,
          environmentId: input.environmentId,
          hostname: requestedHostname,
          tunnelName: requestedTunnelName,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvisioningFailed({
                userId: input.userId,
                environmentId: input.environmentId,
                stage: "reserve-allocation",
                hostname: requestedHostname,
                tunnelName: requestedTunnelName,
                cause,
              }),
          ),
        );
      const { hostname, tunnelName } = allocation;

      if (input.reuseReadyTunnel === true) {
        const reused = yield* reuseReadyTunnel(allocation, input.origin);
        if (Option.isSome(reused)) {
          return reused.value;
        }
      }

      const tunnelResponse = yield* tunnels.list({ name: tunnelName, isDeleted: false }).pipe(
        Effect.map((tunnels) => tunnels.result),
        Effect.map(Arr.findFirst((tunnel) => tunnel.name === tunnelName)),
        Effect.flatMap(
          Option.match({
            onSome: (tunnel) => Effect.succeed(tunnel),
            onNone: () => tunnels.create({ name: tunnelName, configSrc: "cloudflare" }),
          }),
        ),
        Effect.mapError(
          (cause) =>
            new ManagedEndpointProvisioningFailed({
              userId: input.userId,
              environmentId: input.environmentId,
              stage: "ensure-tunnel",
              hostname,
              tunnelName,
              cause,
            }),
        ),
      );
      if (!tunnelResponse.id || tunnelResponse.name !== tunnelName) {
        return yield* new ManagedEndpointProvisioningFailed({
          userId: input.userId,
          environmentId: input.environmentId,
          stage: "validate-tunnel-response",
          reason: "invalid-tunnel-response",
          hostname,
          tunnelName,
          ...(tunnelResponse.id ? { returnedTunnelId: tunnelResponse.id } : {}),
          ...(tunnelResponse.name ? { returnedTunnelName: tunnelResponse.name } : {}),
        });
      }
      const tunnel = { id: tunnelResponse.id, name: tunnelResponse.name };
      const tunnelGeneration = yield* allocations
        .recordTunnel({
          userId: input.userId,
          environmentId: input.environmentId,
          tunnelId: tunnel.id,
          generation: allocation.generation,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvisioningFailed({
                userId: input.userId,
                environmentId: input.environmentId,
                stage: "record-tunnel",
                hostname,
                tunnelName,
                tunnelId: tunnel.id,
                cause,
              }),
          ),
        );
      if (tunnelGeneration === null) {
        // A newer provision can adopt this tunnel by name after our claim fails; leave it available.
        return yield* new ManagedEndpointProvisioningFailed({
          userId: input.userId,
          environmentId: input.environmentId,
          stage: "record-tunnel",
          reason: "claim-lost",
          hostname,
          tunnelName,
          tunnelId: tunnel.id,
        });
      }

      const configured = yield* allocations
        .withClaimedTunnel(
          {
            userId: input.userId,
            environmentId: input.environmentId,
            tunnelId: tunnel.id,
            generation: tunnelGeneration,
          },
          tunnels
            .putConfiguration(tunnel.id, {
              ingress: [
                {
                  hostname,
                  service: formatOriginService(input.origin),
                },
                { service: "http_status:404" },
              ],
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointProvisioningFailed({
                    userId: input.userId,
                    environmentId: input.environmentId,
                    stage: "configure-tunnel",
                    hostname,
                    tunnelName,
                    tunnelId: tunnel.id,
                    cause,
                  }),
              ),
            ),
        )
        .pipe(
          Effect.catchTags({
            ManagedEndpointAllocationPersistenceError: (cause) =>
              Effect.fail(
                new ManagedEndpointProvisioningFailed({
                  userId: input.userId,
                  environmentId: input.environmentId,
                  stage: "configure-tunnel",
                  hostname,
                  tunnelName,
                  tunnelId: tunnel.id,
                  cause,
                }),
              ),
          }),
        );
      if (Option.isNone(configured)) {
        return yield* new ManagedEndpointProvisioningFailed({
          userId: input.userId,
          environmentId: input.environmentId,
          stage: "configure-tunnel",
          reason: "claim-lost",
          hostname,
          tunnelName,
          tunnelId: tunnel.id,
        });
      }

      const dnsRecord = {
        type: "CNAME",
        name: hostname,
        content: `${tunnel.id}.cfargotunnel.com`,
        ttl: 1,
        proxied: true,
      } as const;

      const recordedDns = yield* allocations
        .withClaimedTunnel(
          {
            userId: input.userId,
            environmentId: input.environmentId,
            tunnelId: tunnel.id,
            generation: tunnelGeneration,
          },
          Effect.gen(function* () {
            const dnsRecordId = yield* ensureDnsRecord(
              hostname,
              allocation.dnsRecordId,
              dnsRecord,
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointProvisioningFailed({
                    userId: input.userId,
                    environmentId: input.environmentId,
                    stage: "ensure-dns-record",
                    hostname,
                    tunnelName,
                    tunnelId: tunnel.id,
                    ...(allocation.dnsRecordId === null
                      ? {}
                      : { dnsRecordId: allocation.dnsRecordId }),
                    cause,
                  }),
              ),
            );
            const dnsGeneration = yield* allocations
              .recordDns({
                userId: input.userId,
                environmentId: input.environmentId,
                dnsRecordId,
                tunnelId: tunnel.id,
                generation: tunnelGeneration,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ManagedEndpointProvisioningFailed({
                      userId: input.userId,
                      environmentId: input.environmentId,
                      stage: "record-dns",
                      hostname,
                      tunnelName,
                      tunnelId: tunnel.id,
                      dnsRecordId,
                      cause,
                    }),
                ),
              );
            if (dnsGeneration === null) {
              return yield* new ManagedEndpointProvisioningFailed({
                userId: input.userId,
                environmentId: input.environmentId,
                stage: "record-dns",
                reason: "claim-lost",
                hostname,
                tunnelName,
                tunnelId: tunnel.id,
                dnsRecordId,
              });
            }
            return { dnsRecordId, dnsGeneration };
          }),
        )
        .pipe(
          Effect.catchTags({
            ManagedEndpointAllocationPersistenceError: (cause) =>
              Effect.fail(
                new ManagedEndpointProvisioningFailed({
                  userId: input.userId,
                  environmentId: input.environmentId,
                  stage: "record-dns",
                  hostname,
                  tunnelName,
                  tunnelId: tunnel.id,
                  cause,
                }),
              ),
          }),
        );
      if (Option.isNone(recordedDns)) {
        return yield* new ManagedEndpointProvisioningFailed({
          userId: input.userId,
          environmentId: input.environmentId,
          stage: "record-dns",
          reason: "claim-lost",
          hostname,
          tunnelName,
          tunnelId: tunnel.id,
        });
      }
      const { dnsRecordId, dnsGeneration } = recordedDns.value;

      const connectorToken = yield* tunnels.getToken(tunnel.id).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedEndpointProvisioningFailed({
              userId: input.userId,
              environmentId: input.environmentId,
              stage: "get-tunnel-token",
              hostname,
              tunnelName,
              tunnelId: tunnel.id,
              dnsRecordId,
              cause,
            }),
        ),
      );
      const ready = yield* allocations
        .markReady({
          userId: input.userId,
          environmentId: input.environmentId,
          tunnelId: tunnel.id,
          generation: dnsGeneration,
          origin: input.origin,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvisioningFailed({
                userId: input.userId,
                environmentId: input.environmentId,
                stage: "mark-allocation-ready",
                hostname,
                tunnelName,
                tunnelId: tunnel.id,
                dnsRecordId,
                cause,
              }),
          ),
        );
      if (!ready) {
        return yield* new ManagedEndpointProvisioningFailed({
          userId: input.userId,
          environmentId: input.environmentId,
          stage: "mark-allocation-ready",
          reason: "claim-lost",
          hostname,
          tunnelName,
          tunnelId: tunnel.id,
          dnsRecordId,
        });
      }

      return {
        endpoint: managedEndpointForHostname(hostname),
        runtime: {
          providerKind: "cloudflare_tunnel",
          connectorToken,
          tunnelId: tunnel.id,
          tunnelName: tunnel.name,
        },
      } satisfies ManagedEndpointProvisioningResult;
    }),
  });
});

export const layer = Layer.effect(ManagedEndpointProvider, make);

export const layerCloudflareBindings = (
  tunnelClient: Cloudflare.Tunnel.ReadWriteTunnelClient,
  dnsClient: Cloudflare.DNS.ReadWriteDnsClient,
  alchemyRuntimeContext: Alchemy.BaseRuntimeContext,
) => {
  // Created once per isolate so its cached pause survives layer rebuilds.
  const cloudflare = makeCloudflareApiGate(alchemyRuntimeContext);
  return layer.pipe(
    Layer.provideMerge(
      Layer.unwrap(
        Effect.gen(function* () {
          const pause = yield* CloudflareApiPause.CloudflareApiPause;
          const gate = cloudflare(pause);
          return Layer.mergeAll(
            layerTunnelClient({
              get: (tunnelId) =>
                gate(tunnelClient.get(tunnelId)).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ManagedEndpointTunnelClientError({
                        operation: "get",
                        tunnelId,
                        cause,
                      }),
                  ),
                ),
              list: (request) =>
                gate(tunnelClient.list(request)).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ManagedEndpointTunnelClientError({
                        operation: "list",
                        ...(request.name === undefined ? {} : { tunnelName: request.name }),
                        cause,
                      }),
                  ),
                ),
              create: (request) =>
                gate(tunnelClient.create(request)).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ManagedEndpointTunnelClientError({
                        operation: "create",
                        tunnelName: request.name,
                        cause,
                      }),
                  ),
                ),
              putConfiguration: (tunnelId, config) =>
                gate(tunnelClient.putConfiguration(tunnelId, config)).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ManagedEndpointTunnelClientError({
                        operation: "put-configuration",
                        tunnelId,
                        cause,
                      }),
                  ),
                ),
              getToken: (tunnelId) =>
                gate(tunnelClient.getToken(tunnelId)).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ManagedEndpointTunnelClientError({
                        operation: "get-token",
                        tunnelId,
                        cause,
                      }),
                  ),
                ),
              delete: (tunnelId) =>
                gate(tunnelClient.delete(tunnelId)).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ManagedEndpointTunnelClientError({
                        operation: "delete",
                        tunnelId,
                        cause,
                      }),
                  ),
                ),
            }),
            layerDnsClient({
              listRecords: (hostname) =>
                gate(dnsClient.listDnsRecords({ search: hostname })).pipe(
                  Effect.map((response) =>
                    response.result.filter(
                      (record): record is typeof record & { readonly id: string } =>
                        typeof record.id === "string" &&
                        normalizeHostname(record.name) === normalizeHostname(hostname),
                    ),
                  ),
                  Effect.mapError(
                    (cause) =>
                      new ManagedEndpointDnsClientError({
                        operation: "list-records",
                        hostname,
                        cause,
                      }),
                  ),
                ),
              createRecord: (request) =>
                gate(dnsClient.createDnsRecord(request)).pipe(
                  Effect.map((response) => ({ id: response.id })),
                  Effect.mapError(
                    (cause) =>
                      new ManagedEndpointDnsClientError({
                        operation: "create-record",
                        hostname: request.name,
                        cause,
                      }),
                  ),
                ),
              updateRecord: (dnsRecordId, request) =>
                gate(dnsClient.updateDnsRecord(dnsRecordId, request)).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ManagedEndpointDnsClientError({
                        operation: "update-record",
                        hostname: request.name,
                        dnsRecordId,
                        cause,
                      }),
                  ),
                ),
              deleteRecord: (dnsRecordId) =>
                gate(dnsClient.deleteDnsRecord(dnsRecordId)).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ManagedEndpointDnsClientError({
                        operation: "delete-record",
                        dnsRecordId,
                        cause,
                      }),
                  ),
                ),
            }),
          );
        }),
      ),
    ),
  );
};
