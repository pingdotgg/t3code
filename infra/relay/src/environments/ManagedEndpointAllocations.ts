import type { RelayManagedEndpoint, RelayManagedEndpointOrigin } from "@t3tools/contracts/relay";
import { and, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { isSqlError } from "effect/unstable/sql/SqlError";

import * as RelayDb from "../db.ts";
import { isManagedEndpointHostname, managedEndpointForHostname } from "../deploymentConfig.ts";
import { relayEnvironmentLinks, relayManagedEndpointAllocations } from "../persistence/schema.ts";

export interface ManagedEndpointAllocation {
  readonly userId: string;
  readonly environmentId: string;
  readonly hostname: string;
  readonly tunnelId: string | null;
  readonly tunnelName: string;
  readonly dnsRecordId: string | null;
  readonly readyAt: string | null;
  readonly origin: RelayManagedEndpointOrigin | null;
  readonly updatedAt: string;
  readonly generation: number;
}

export interface ManagedEndpointTunnelAllocation extends ManagedEndpointAllocation {
  readonly recoveryEnabled: boolean;
}

export const MANAGED_ENDPOINT_ALLOCATION_LOOKUP_BATCH_SIZE = 500;

export function resolveReadyManagedEndpoint(input: {
  readonly allocation: ManagedEndpointAllocation;
  readonly baseDomain: string | undefined;
}): RelayManagedEndpoint | null {
  if (
    !input.baseDomain ||
    input.allocation.readyAt === null ||
    input.allocation.tunnelId === null ||
    input.allocation.dnsRecordId === null ||
    !isManagedEndpointHostname(input.allocation.hostname, input.baseDomain)
  ) {
    return null;
  }
  return managedEndpointForHostname(input.allocation.hostname);
}

export class ManagedEndpointAllocationPersistenceError extends Schema.TaggedErrorClass<ManagedEndpointAllocationPersistenceError>()(
  "ManagedEndpointAllocationPersistenceError",
  {
    operation: Schema.Literals([
      "get",
      "reserve",
      "record-tunnel",
      "record-dns",
      "mark-ready",
      "enable-recovery",
      "list-tunnels",
      "lock-tunnel",
      "claim-release",
      "claim-deprovision",
      "remove",
      "remove-claimed",
    ]),
    stage: Schema.Literals(["database-request", "resolve-reservation"]),
    userId: Schema.String,
    environmentId: Schema.String,
    hostname: Schema.optionalKey(Schema.String),
    tunnelName: Schema.optionalKey(Schema.String),
    tunnelId: Schema.optionalKey(Schema.String),
    dnsRecordId: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Managed endpoint allocation '${this.operation}' failed during '${this.stage}' for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

interface ManagedEndpointAllocationKey {
  readonly userId: string;
  readonly environmentId: string;
}

interface ReserveManagedEndpointAllocationInput extends ManagedEndpointAllocationKey {
  readonly hostname: string;
  readonly tunnelName: string;
}

interface RecordManagedEndpointTunnelInput extends ManagedEndpointAllocationKey {
  readonly tunnelId: string;
  readonly generation: number;
}

interface RecordManagedEndpointDnsInput extends ManagedEndpointAllocationKey {
  readonly dnsRecordId: string;
  readonly tunnelId: string;
  readonly generation: number;
}

interface MarkManagedEndpointReadyInput extends ManagedEndpointAllocationKey {
  readonly tunnelId: string;
  readonly generation: number;
  readonly origin: RelayManagedEndpointOrigin;
}

interface ClaimManagedEndpointReleaseInput extends ManagedEndpointAllocationKey {
  readonly tunnelId: string;
  readonly generation: number;
}

interface EnableManagedEndpointRecoveryInput extends ManagedEndpointAllocationKey {
  readonly tunnelId: string;
  readonly environmentPublicKey: string;
  readonly origin: RelayManagedEndpointOrigin;
}

interface ClaimManagedEndpointDeprovisionInput extends ManagedEndpointAllocationKey {
  readonly generation: number;
}

interface RemoveClaimedManagedEndpointAllocationInput extends ManagedEndpointAllocationKey {
  readonly generation: number;
}

export class ManagedEndpointAllocations extends Context.Service<
  ManagedEndpointAllocations,
  {
    readonly get: (
      input: ManagedEndpointAllocationKey,
    ) => Effect.Effect<ManagedEndpointAllocation | null, ManagedEndpointAllocationPersistenceError>;
    readonly reserve: (
      input: ReserveManagedEndpointAllocationInput,
    ) => Effect.Effect<ManagedEndpointAllocation, ManagedEndpointAllocationPersistenceError>;
    readonly recordTunnel: (
      input: RecordManagedEndpointTunnelInput,
    ) => Effect.Effect<number | null, ManagedEndpointAllocationPersistenceError>;
    readonly recordDns: (
      input: RecordManagedEndpointDnsInput,
    ) => Effect.Effect<number | null, ManagedEndpointAllocationPersistenceError>;
    readonly markReady: (
      input: MarkManagedEndpointReadyInput,
    ) => Effect.Effect<boolean, ManagedEndpointAllocationPersistenceError>;
    readonly enableRecovery: (
      input: EnableManagedEndpointRecoveryInput,
    ) => Effect.Effect<boolean, ManagedEndpointAllocationPersistenceError>;
    readonly listByTunnelNames: (
      tunnelNames: ReadonlyArray<string>,
    ) => Effect.Effect<
      ReadonlyArray<ManagedEndpointTunnelAllocation>,
      ManagedEndpointAllocationPersistenceError
    >;
    /**
     * Atomically claims the right to delete the allocation's tunnel: succeeds
     * only while the recorded tunnel and generation still match what the
     * caller loaded. A concurrent provision increments `generation` when it
     * records its tunnel, which makes a stale claim fail and keeps the freshly
     * issued tunnel alive.
     */
    readonly claimRelease: (
      input: ClaimManagedEndpointReleaseInput,
    ) => Effect.Effect<number | null, ManagedEndpointAllocationPersistenceError>;
    readonly withClaimedTunnel: <A, E, R>(
      input: ClaimManagedEndpointReleaseInput,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E | ManagedEndpointAllocationPersistenceError, R>;
    /**
     * Claims the complete allocation for teardown only if its generation still
     * matches the snapshot captured by the unlink operation.
     *
     * Returns the claim generation used by `removeClaimed`, or null when a
     * concurrent provision has already superseded the snapshot.
     */
    readonly claimDeprovision: (
      input: ClaimManagedEndpointDeprovisionInput,
    ) => Effect.Effect<number | null, ManagedEndpointAllocationPersistenceError>;
    readonly remove: (
      input: ManagedEndpointAllocationKey,
    ) => Effect.Effect<void, ManagedEndpointAllocationPersistenceError>;
    readonly removeClaimed: (
      input: RemoveClaimedManagedEndpointAllocationInput,
    ) => Effect.Effect<boolean, ManagedEndpointAllocationPersistenceError>;
  }
>()("t3code-relay/environments/ManagedEndpointAllocations") {}

const allocationSelection = {
  userId: relayManagedEndpointAllocations.userId,
  environmentId: relayManagedEndpointAllocations.environmentId,
  hostname: relayManagedEndpointAllocations.hostname,
  tunnelId: relayManagedEndpointAllocations.tunnelId,
  tunnelName: relayManagedEndpointAllocations.tunnelName,
  dnsRecordId: relayManagedEndpointAllocations.dnsRecordId,
  readyAt: relayManagedEndpointAllocations.readyAt,
  origin: relayManagedEndpointAllocations.origin,
  updatedAt: relayManagedEndpointAllocations.updatedAt,
  generation: relayManagedEndpointAllocations.generation,
};

const whereAllocation = (input: ManagedEndpointAllocationKey) =>
  and(
    eq(relayManagedEndpointAllocations.userId, input.userId),
    eq(relayManagedEndpointAllocations.environmentId, input.environmentId),
  );

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return ManagedEndpointAllocations.of({
    get: Effect.fn("relay.managed_endpoint_allocations.get")(function* (
      input: ManagedEndpointAllocationKey,
    ) {
      return yield* db
        .select(allocationSelection)
        .from(relayManagedEndpointAllocations)
        .where(whereAllocation(input))
        .limit(1)
        .pipe(
          Effect.map((rows) => rows[0] ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "get",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
    }),
    reserve: Effect.fn("relay.managed_endpoint_allocations.reserve")(function* (
      input: ReserveManagedEndpointAllocationInput,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const inserted = yield* db
        .insert(relayManagedEndpointAllocations)
        .values({
          ...input,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning(allocationSelection)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "reserve",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );

      const allocation =
        inserted[0] ??
        (yield* db
          .select(allocationSelection)
          .from(relayManagedEndpointAllocations)
          .where(whereAllocation(input))
          .limit(1)
          .pipe(
            Effect.map((rows) => rows[0]),
            Effect.mapError(
              (cause) =>
                new ManagedEndpointAllocationPersistenceError({
                  operation: "reserve",
                  stage: "database-request",
                  ...input,
                  cause,
                }),
            ),
          ));

      if (allocation === undefined) {
        return yield* new ManagedEndpointAllocationPersistenceError({
          operation: "reserve",
          stage: "resolve-reservation",
          ...input,
        });
      }

      return allocation;
    }),
    recordTunnel: Effect.fn("relay.managed_endpoint_allocations.record_tunnel")(function* (
      input: RecordManagedEndpointTunnelInput,
    ) {
      return yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          tunnelId: input.tunnelId,
          readyAt: sql`case when ${relayManagedEndpointAllocations.tunnelId} = ${input.tunnelId} then ${relayManagedEndpointAllocations.readyAt} else null end`,
          origin: sql`case when ${relayManagedEndpointAllocations.tunnelId} = ${input.tunnelId} then ${relayManagedEndpointAllocations.origin} else null end`,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
        })
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ generation: relayManagedEndpointAllocations.generation })
        .pipe(
          Effect.map((rows) => rows[0]?.generation ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "record-tunnel",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
    }),
    recordDns: Effect.fn("relay.managed_endpoint_allocations.record_dns")(function* (
      input: RecordManagedEndpointDnsInput,
    ) {
      return yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          dnsRecordId: input.dnsRecordId,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
        })
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.tunnelId, input.tunnelId),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ generation: relayManagedEndpointAllocations.generation })
        .pipe(
          Effect.map((rows) => rows[0]?.generation ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "record-dns",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
    }),
    markReady: Effect.fn("relay.managed_endpoint_allocations.mark_ready")(function* (
      input: MarkManagedEndpointReadyInput,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      return yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          readyAt: now,
          origin: input.origin,
          updatedAt: now,
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
        })
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.tunnelId, input.tunnelId),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ environmentId: relayManagedEndpointAllocations.environmentId })
        .pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "mark-ready",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
    }),
    enableRecovery: Effect.fn("relay.managed_endpoint_allocations.enable_recovery")(function* (
      input: EnableManagedEndpointRecoveryInput,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      return yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          recoveryEnabledAt: now,
          recoveryEnvironmentPublicKey: input.environmentPublicKey,
          updatedAt: now,
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
        })
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.tunnelId, input.tunnelId),
            eq(relayManagedEndpointAllocations.origin, input.origin),
            exists(
              new QueryBuilder()
                .select({ userId: relayEnvironmentLinks.userId })
                .from(relayEnvironmentLinks)
                .where(
                  and(
                    eq(relayEnvironmentLinks.userId, input.userId),
                    eq(relayEnvironmentLinks.environmentId, input.environmentId),
                    eq(relayEnvironmentLinks.environmentPublicKey, input.environmentPublicKey),
                    eq(relayEnvironmentLinks.endpointProviderKind, "cloudflare_tunnel"),
                    isNull(relayEnvironmentLinks.revokedAt),
                  ),
                )
                .for("update"),
            ),
          ),
        )
        .returning({ environmentId: relayManagedEndpointAllocations.environmentId })
        .pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "enable-recovery",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
    }),
    listByTunnelNames: Effect.fn("relay.managed_endpoint_allocations.list_by_tunnel_names")(
      function* (tunnelNames: ReadonlyArray<string>) {
        if (tunnelNames.length === 0) {
          return [];
        }
        const batches = Array.from(
          { length: Math.ceil(tunnelNames.length / MANAGED_ENDPOINT_ALLOCATION_LOOKUP_BATCH_SIZE) },
          (_, index) =>
            tunnelNames.slice(
              index * MANAGED_ENDPOINT_ALLOCATION_LOOKUP_BATCH_SIZE,
              (index + 1) * MANAGED_ENDPOINT_ALLOCATION_LOOKUP_BATCH_SIZE,
            ),
        );
        const results = yield* Effect.forEach(
          batches,
          (batch) =>
            db
              .select({
                ...allocationSelection,
                recoveryEnabledAt: relayManagedEndpointAllocations.recoveryEnabledAt,
                recoveryEnvironmentPublicKey:
                  relayManagedEndpointAllocations.recoveryEnvironmentPublicKey,
                linkedEnvironmentPublicKey: relayEnvironmentLinks.environmentPublicKey,
              })
              .from(relayManagedEndpointAllocations)
              .leftJoin(
                relayEnvironmentLinks,
                and(
                  eq(relayEnvironmentLinks.userId, relayManagedEndpointAllocations.userId),
                  eq(
                    relayEnvironmentLinks.environmentId,
                    relayManagedEndpointAllocations.environmentId,
                  ),
                  isNull(relayEnvironmentLinks.revokedAt),
                ),
              )
              .where(inArray(relayManagedEndpointAllocations.tunnelName, batch))
              .pipe(
                Effect.map((rows) =>
                  rows.map(
                    ({
                      recoveryEnabledAt,
                      recoveryEnvironmentPublicKey,
                      linkedEnvironmentPublicKey,
                      ...allocation
                    }) => ({
                      ...allocation,
                      recoveryEnabled:
                        recoveryEnabledAt !== null &&
                        recoveryEnvironmentPublicKey !== null &&
                        recoveryEnvironmentPublicKey === linkedEnvironmentPublicKey,
                    }),
                  ),
                ),
                Effect.mapError(
                  (cause) =>
                    new ManagedEndpointAllocationPersistenceError({
                      operation: "list-tunnels",
                      stage: "database-request",
                      userId: "*",
                      environmentId: "*",
                      cause,
                    }),
                ),
              ),
          { concurrency: 1 },
        );
        return results.flat();
      },
    ),
    claimRelease: Effect.fn("relay.managed_endpoint_allocations.claim_release")(function* (
      input: ClaimManagedEndpointReleaseInput,
    ) {
      const claimed = yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          updatedAt: DateTime.formatIso(yield* DateTime.now),
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
        })
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.tunnelId, input.tunnelId),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ generation: relayManagedEndpointAllocations.generation })
        .pipe(
          Effect.map((rows) => rows[0]?.generation ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "claim-release",
                stage: "database-request",
                userId: input.userId,
                environmentId: input.environmentId,
                tunnelId: input.tunnelId,
                cause,
              }),
          ),
        );
      return claimed;
    }),
    withClaimedTunnel: Effect.fn("relay.managed_endpoint_allocations.with_claimed_tunnel")(
      function* <A, E, R>(
        input: ClaimManagedEndpointReleaseInput,
        effect: Effect.Effect<A, E, R>,
      ): Effect.fn.Return<Option.Option<A>, E | ManagedEndpointAllocationPersistenceError, R> {
        const lockError = (cause: unknown) =>
          new ManagedEndpointAllocationPersistenceError({
            operation: "lock-tunnel",
            stage: "database-request",
            userId: input.userId,
            environmentId: input.environmentId,
            tunnelId: input.tunnelId,
            cause,
          });
        return yield* db.$client
          .withTransaction(
            db
              .select({ generation: relayManagedEndpointAllocations.generation })
              .from(relayManagedEndpointAllocations)
              .where(
                and(
                  whereAllocation(input),
                  eq(relayManagedEndpointAllocations.tunnelId, input.tunnelId),
                  eq(relayManagedEndpointAllocations.generation, input.generation),
                ),
              )
              .limit(1)
              .for("update")
              .pipe(
                Effect.mapError(lockError),
                Effect.flatMap((rows) =>
                  rows.length === 0
                    ? Effect.succeed(Option.none())
                    : effect.pipe(Effect.map(Option.some)),
                ),
              ),
          )
          .pipe(Effect.mapError((cause) => (isSqlError(cause) ? lockError(cause) : cause)));
      },
    ),
    claimDeprovision: Effect.fn("relay.managed_endpoint_allocations.claim_deprovision")(function* (
      input: ClaimManagedEndpointDeprovisionInput,
    ) {
      const claimed = yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          updatedAt: DateTime.formatIso(yield* DateTime.now),
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
        })
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ generation: relayManagedEndpointAllocations.generation })
        .pipe(
          Effect.map((rows) => rows[0]?.generation ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "claim-deprovision",
                stage: "database-request",
                userId: input.userId,
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
      return claimed;
    }),
    remove: Effect.fn("relay.managed_endpoint_allocations.remove")(function* (
      input: ManagedEndpointAllocationKey,
    ) {
      yield* db
        .delete(relayManagedEndpointAllocations)
        .where(whereAllocation(input))
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "remove",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
    }),
    removeClaimed: Effect.fn("relay.managed_endpoint_allocations.remove_claimed")(function* (
      input: RemoveClaimedManagedEndpointAllocationInput,
    ) {
      return yield* db
        .delete(relayManagedEndpointAllocations)
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ userId: relayManagedEndpointAllocations.userId })
        .pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "remove-claimed",
                stage: "database-request",
                userId: input.userId,
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(ManagedEndpointAllocations, make);
