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
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to persist managed endpoint allocation";
  }
}
const isManagedEndpointAllocationPersistenceError = Schema.is(
  ManagedEndpointAllocationPersistenceError,
);

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
    readonly remove: (
      input: ManagedEndpointAllocationKey,
    ) => Effect.Effect<void, ManagedEndpointAllocationPersistenceError>;
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
};

const whereAllocation = (input: ManagedEndpointAllocationKey) =>
  and(
    eq(relayManagedEndpointAllocations.userId, input.userId),
    eq(relayManagedEndpointAllocations.environmentId, input.environmentId),
  );

const persistenceError = (cause: unknown) =>
  isManagedEndpointAllocationPersistenceError(cause)
    ? cause
    : new ManagedEndpointAllocationPersistenceError({ cause });

const make = Effect.gen(function* () {
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
          Effect.mapError(persistenceError),
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
        .returning(allocationSelection);

      const allocation =
        inserted[0] ??
        (yield* db
          .select(allocationSelection)
          .from(relayManagedEndpointAllocations)
          .where(whereAllocation(input))
          .limit(1)
          .pipe(Effect.map((rows) => rows[0])));

      if (allocation === undefined) {
        return yield* new ManagedEndpointAllocationPersistenceError({
          cause: new Error("Managed endpoint allocation was not persisted."),
        });
      }

      return allocation;
    }, Effect.mapError(persistenceError)),
    recordTunnel: Effect.fn("relay.managed_endpoint_allocations.record_tunnel")(function* (
      input: RecordManagedEndpointTunnelInput,
    ) {
      yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          tunnelId: input.tunnelId,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .where(whereAllocation(input));
    }, Effect.mapError(persistenceError)),
    recordDns: Effect.fn("relay.managed_endpoint_allocations.record_dns")(function* (
      input: RecordManagedEndpointDnsInput,
    ) {
      yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          dnsRecordId: input.dnsRecordId,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .where(whereAllocation(input));
    }, Effect.mapError(persistenceError)),
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
        .where(whereAllocation(input));
    }, Effect.mapError(persistenceError)),
    remove: Effect.fn("relay.managed_endpoint_allocations.remove")(function* (
      input: ManagedEndpointAllocationKey,
    ) {
      yield* db.delete(relayManagedEndpointAllocations).where(whereAllocation(input));
    }, Effect.mapError(persistenceError)),
  });
});

export const layer = Layer.effect(ManagedEndpointAllocations, make);
