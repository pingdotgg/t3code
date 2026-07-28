import type { RelayManagedEndpoint } from "@t3tools/contracts/relay";
import { and, eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { isManagedEndpointHostname, managedEndpointForHostname } from "../deploymentConfig.ts";
import { relayManagedEndpointAllocations } from "../persistence/schema.ts";

export interface ManagedEndpointAllocation {
  readonly userId: string;
  readonly environmentId: string;
  readonly hostname: string;
  readonly tunnelId: string | null;
  readonly tunnelName: string;
  readonly dnsRecordId: string | null;
  readonly readyAt: string | null;
  /**
   * Doubles as the allocation's generation marker: every mutation rewrites it,
   * so `claimRelease` can detect a provision that raced a release.
   */
  readonly updatedAt: string;
}

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
}

interface RecordManagedEndpointDnsInput extends ManagedEndpointAllocationKey {
  readonly dnsRecordId: string;
}

interface ClaimManagedEndpointReleaseInput extends ManagedEndpointAllocationKey {
  readonly tunnelId: string;
  readonly updatedAt: string;
}

interface ClaimManagedEndpointDeprovisionInput extends ManagedEndpointAllocationKey {
  readonly updatedAt: string;
}

interface RemoveClaimedManagedEndpointAllocationInput extends ManagedEndpointAllocationKey {
  readonly updatedAt: string;
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
    ) => Effect.Effect<void, ManagedEndpointAllocationPersistenceError>;
    readonly recordDns: (
      input: RecordManagedEndpointDnsInput,
    ) => Effect.Effect<void, ManagedEndpointAllocationPersistenceError>;
    readonly markReady: (
      input: ManagedEndpointAllocationKey,
    ) => Effect.Effect<void, ManagedEndpointAllocationPersistenceError>;
    /**
     * Atomically claims the right to delete the allocation's tunnel: succeeds
     * only while the recorded tunnel and generation still match what the
     * caller loaded. A concurrent provision rewrites `updatedAt` when it
     * records its tunnel, which makes a stale claim fail and keeps the freshly
     * issued tunnel alive.
     */
    readonly claimRelease: (
      input: ClaimManagedEndpointReleaseInput,
    ) => Effect.Effect<boolean, ManagedEndpointAllocationPersistenceError>;
    /**
     * Claims the complete allocation for teardown only if its generation still
     * matches the snapshot captured by the unlink operation.
     *
     * Returns the claim generation used by `removeClaimed`, or null when a
     * concurrent provision has already superseded the snapshot.
     */
    readonly claimDeprovision: (
      input: ClaimManagedEndpointDeprovisionInput,
    ) => Effect.Effect<string | null, ManagedEndpointAllocationPersistenceError>;
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
  updatedAt: relayManagedEndpointAllocations.updatedAt,
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
      yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          tunnelId: input.tunnelId,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .where(whereAllocation(input))
        .pipe(
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
      yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          dnsRecordId: input.dnsRecordId,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .where(whereAllocation(input))
        .pipe(
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
      input: ManagedEndpointAllocationKey,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          readyAt: now,
          updatedAt: now,
        })
        .where(whereAllocation(input))
        .pipe(
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
    claimRelease: Effect.fn("relay.managed_endpoint_allocations.claim_release")(function* (
      input: ClaimManagedEndpointReleaseInput,
    ) {
      const claimed = yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.tunnelId, input.tunnelId),
            eq(relayManagedEndpointAllocations.updatedAt, input.updatedAt),
          ),
        )
        .returning({ userId: relayManagedEndpointAllocations.userId })
        .pipe(
          Effect.map((rows) => rows.length > 0),
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
    claimDeprovision: Effect.fn("relay.managed_endpoint_allocations.claim_deprovision")(function* (
      input: ClaimManagedEndpointDeprovisionInput,
    ) {
      const claimedAt = DateTime.formatIso(yield* DateTime.now);
      const claimed = yield* db
        .update(relayManagedEndpointAllocations)
        .set({ updatedAt: claimedAt })
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.updatedAt, input.updatedAt),
          ),
        )
        .returning({ userId: relayManagedEndpointAllocations.userId })
        .pipe(
          Effect.map((rows) => rows.length > 0),
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
      return claimed ? claimedAt : null;
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
            eq(relayManagedEndpointAllocations.updatedAt, input.updatedAt),
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
