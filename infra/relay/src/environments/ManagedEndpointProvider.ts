import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
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
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

export class ManagedEndpointProvisioningNotConfigured extends Schema.TaggedErrorClass<ManagedEndpointProvisioningNotConfigured>()(
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
  "sync-origin",
]);

export class ManagedEndpointProvisioningFailed extends Schema.TaggedErrorClass<ManagedEndpointProvisioningFailed>()(
  "ManagedEndpointProvisioningFailed",
  {
    stage: ManagedEndpointProvisioningStage,
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

export class ManagedEndpointDeprovisioningFailed extends Schema.TaggedErrorClass<ManagedEndpointDeprovisioningFailed>()(
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

export class ManagedEndpointOriginNotAllowed extends Schema.TaggedErrorClass<ManagedEndpointOriginNotAllowed>()(
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
    }) => Effect.Effect<ManagedEndpointProvisioningResult, ManagedEndpointProviderError>;
    readonly reconcileOrigin: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly tunnelId: string;
      readonly origin: RelayManagedEndpointOrigin;
      readonly endpoint: RelayManagedEndpoint;
    }) => Effect.Effect<ManagedEndpointOriginSyncResult, ManagedEndpointProviderError>;
    /**
     * Captures the allocation generation owned by an unlink before its link
     * revocation commits. Passing this target to `deprovision` prevents a
     * concurrent relink from having its newer allocation torn down.
     */
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
    /**
     * Deletes the provisioned Cloudflare tunnel while keeping the allocation
     * (hostname + tunnel name reservation) and DNS record. Cloudflare bills per
     * provisioned tunnel, so environments release the tunnel when they shut
     * down; the next `provision` recreates it under the same name and repoints
     * the CNAME, preserving the endpoint URL.
     *
     * Resolves to whether the caller's connector token is now dead: true when
     * the tunnel was deleted (or none was recorded to begin with), false when
     * a concurrent provision outbid the release claim and the recorded tunnel
     * — and any token issued for it — stays live.
     */
    readonly release: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly expectedTunnelId?: string;
      readonly expectedInactiveBefore?: string;
      readonly expectedStatus?: "inactive" | "down";
    }) => Effect.Effect<boolean, ManagedEndpointDeprovisioningFailed>;
  }
>()("t3code-relay/environments/ManagedEndpointProvider") {}

export interface ManagedEndpointTunnel {
  readonly id?: string | null;
  readonly name?: string | null;
  readonly status?: string | null;
  readonly createdAt?: string | null;
  readonly connsInactiveAt?: string | null;
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

export class ManagedEndpointTunnelClientError extends Schema.TaggedErrorClass<ManagedEndpointTunnelClientError>()(
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

export class ManagedEndpointDnsClientError extends Schema.TaggedErrorClass<ManagedEndpointDnsClientError>()(
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

export function isManagedEndpointNotFound(cause: unknown): boolean {
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

export const make = Effect.gen(function* () {
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
            Effect.flatMap((dnsRecordId) =>
              dnsRecordId === null ? Effect.fail(createError) : Effect.succeed(dnsRecordId),
            ),
          ),
      }),
    );
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
          hostname: allocation.hostname,
        });
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
              Effect.flatMap((result) =>
                result === "missing"
                  ? Effect.succeed(result)
                  : allocations
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
      // Claim the release against the allocation's current generation before
      // touching Cloudflare. A provision racing this release (fast environment
      // restart) increments the generation when it records its tunnel, so a stale
      // claim means the recorded tunnel may already back a fresh connector and
      // must be left alive. A provision that starts after the claim instead
      // fails loudly on the deleted tunnel and the client-side retry
      // provisions a replacement.
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
          Effect.map(Option.some),
          Effect.catchTags({
            ManagedEndpointTunnelClientError: (cause) =>
              isManagedEndpointNotFound(cause.cause)
                ? Effect.succeed(Option.none())
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
            yield* deleteTunnel;
            return true;
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
      // The recorded tunnelId is now stale, but the allocation row is left
      // untouched deliberately: connect/status authorization requires a fully
      // recorded allocation, and an offline environment must keep reporting
      // "offline" (health probe fails) rather than "not authorized". The next
      // provision lists tunnels by name, finds none, creates a replacement and
      // re-records the fresh id.
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
          Effect.map(Encoding.encodeHex),
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

      const selectedTunnel = yield* tunnels.list({ name: tunnelName, isDeleted: false }).pipe(
        Effect.map((tunnels) => tunnels.result),
        Effect.map(Arr.findFirst((tunnel) => tunnel.name === tunnelName)),
        Effect.flatMap(
          Option.match({
            onSome: (tunnel) => Effect.succeed({ tunnel, created: false }),
            onNone: () =>
              tunnels
                .create({ name: tunnelName, configSrc: "cloudflare" })
                .pipe(Effect.map((tunnel) => ({ tunnel, created: true }))),
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
      const tunnelResponse = selectedTunnel.tunnel;
      if (!tunnelResponse.id || tunnelResponse.name !== tunnelName) {
        return yield* new ManagedEndpointProvisioningFailed({
          userId: input.userId,
          environmentId: input.environmentId,
          stage: "validate-tunnel-response",
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
        if (selectedTunnel.created) {
          const current = yield* allocations.get(input).pipe(
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
          if (current?.tunnelId !== tunnel.id) {
            yield* ignoreNotFound(tunnels.delete(tunnel.id)).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed to remove a tunnel that lost its allocation", {
                  tunnelId: tunnel.id,
                  tunnelName,
                  cause,
                }),
              ),
            );
          }
        }
        return yield* new ManagedEndpointProvisioningFailed({
          userId: input.userId,
          environmentId: input.environmentId,
          stage: "record-tunnel",
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
) =>
  layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerTunnelClient({
          get: (tunnelId) =>
            tunnelClient.get(tunnelId).pipe(
              Effect.timeout("8 seconds"),
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointTunnelClientError({
                    operation: "get",
                    tunnelId,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          list: (request) =>
            tunnelClient.list(request).pipe(
              Effect.timeout("8 seconds"),
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointTunnelClientError({
                    operation: "list",
                    ...(request.name === undefined ? {} : { tunnelName: request.name }),
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          create: (request) =>
            tunnelClient.create(request).pipe(
              Effect.timeout("8 seconds"),
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointTunnelClientError({
                    operation: "create",
                    tunnelName: request.name,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          putConfiguration: (tunnelId, config) =>
            tunnelClient.putConfiguration(tunnelId, config).pipe(
              Effect.timeout("8 seconds"),
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointTunnelClientError({
                    operation: "put-configuration",
                    tunnelId,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          getToken: (tunnelId) =>
            tunnelClient.getToken(tunnelId).pipe(
              Effect.timeout("8 seconds"),
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointTunnelClientError({
                    operation: "get-token",
                    tunnelId,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          delete: (tunnelId) =>
            tunnelClient.delete(tunnelId).pipe(
              Effect.timeout("8 seconds"),
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointTunnelClientError({
                    operation: "delete",
                    tunnelId,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
        }),
        layerDnsClient({
          listRecords: (hostname) =>
            dnsClient.listDnsRecords({ search: hostname }).pipe(
              Effect.timeout("8 seconds"),
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
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          createRecord: (request) =>
            dnsClient.createDnsRecord(request).pipe(
              Effect.timeout("8 seconds"),
              Effect.map((response) => ({ id: response.id })),
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointDnsClientError({
                    operation: "create-record",
                    hostname: request.name,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          updateRecord: (dnsRecordId, request) =>
            dnsClient.updateDnsRecord(dnsRecordId, request).pipe(
              Effect.timeout("8 seconds"),
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointDnsClientError({
                    operation: "update-record",
                    hostname: request.name,
                    dnsRecordId,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          deleteRecord: (dnsRecordId) =>
            dnsClient.deleteDnsRecord(dnsRecordId).pipe(
              Effect.timeout("8 seconds"),
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointDnsClientError({
                    operation: "delete-record",
                    dnsRecordId,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
        }),
      ),
    ),
  );
