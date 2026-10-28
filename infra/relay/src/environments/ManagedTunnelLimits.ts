import { and, count, eq, exists, gt, gte, isNotNull, isNull, ne, not, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlError from "effect/sql/SqlError";

import * as RelayDb from "../db.ts";
import {
  relayEnvironmentLinks,
  relayManagedEndpointAllocations,
  relayManagedTunnelLimits,
} from "../persistence/schema.ts";

export const DEFAULT_MANAGED_TUNNEL_LIMIT = 3;
// Reserve-to-tunnel takes two Cloudflare calls capped at 8 seconds each; a reservation older than this was abandoned.
const MANAGED_TUNNEL_PENDING_WINDOW_MINUTES = 15;

export class ManagedTunnelLimitPersistenceError extends Schema.TaggedError<ManagedTunnelLimitPersistenceError>()(
  "ManagedTunnelLimitPersistenceError",
  {
    operation: Schema.Literals(["transaction", "lock-user", "load-limit", "count-tunnels"]),
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Managed tunnel limit '${this.operation}' failed for user '${this.userId}'`;
  }
}

export class ManagedTunnelLimitExceeded extends Schema.TaggedError<ManagedTunnelLimitExceeded>()(
  "ManagedTunnelLimitExceeded",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    maxTunnels: Schema.Number,
    activeTunnels: Schema.Number,
  },
) {
  override get message(): string {
    return `Managed tunnel limit reached for user '${this.userId}': ${this.activeTunnels} of ${this.maxTunnels} tunnels in use`;
  }
}

export class ManagedTunnelLimits extends Context.Service<
  ManagedTunnelLimits,
  {
    /** Runs `reserve` only while the user is under their limit, serialized per user in one transaction. */
    readonly withCapacity: <A, E, R>(
      input: { readonly userId: string; readonly environmentId: string },
      reserve: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ManagedTunnelLimitExceeded | ManagedTunnelLimitPersistenceError, R>;
  }
>()("t3code-relay/environments/ManagedTunnelLimits") {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return ManagedTunnelLimits.of({
    withCapacity: Effect.fn("relay.managed_tunnel_limits.with_capacity")(function* <A, E, R>(
      input: { readonly userId: string; readonly environmentId: string },
      reserve: Effect.Effect<A, E, R>,
    ): Effect.fn.Return<A, E | ManagedTunnelLimitExceeded | ManagedTunnelLimitPersistenceError, R> {
      const checkAndReserve = Effect.gen(function* () {
        // Held until commit, so the count below sees every reservation that took the lock first.
        yield* db
          .execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`managed-tunnel-limit:${input.userId}`}, 0))`,
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ManagedTunnelLimitPersistenceError({
                  operation: "lock-user",
                  userId: input.userId,
                  cause,
                }),
            ),
          );

        const overrides = yield* db
          .select({ maxTunnels: relayManagedTunnelLimits.maxTunnels })
          .from(relayManagedTunnelLimits)
          .where(eq(relayManagedTunnelLimits.userId, input.userId))
          .limit(1)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ManagedTunnelLimitPersistenceError({
                  operation: "load-limit",
                  userId: input.userId,
                  cause,
                }),
            ),
          );
        const maxTunnels = overrides[0]?.maxTunnels ?? DEFAULT_MANAGED_TUNNEL_LIMIT;

        const pendingCutoff = DateTime.formatIso(
          DateTime.subtract(yield* DateTime.now, {
            minutes: MANAGED_TUNNEL_PENDING_WINDOW_MINUTES,
          }),
        );
        // Counts allocations, not links: a link is written only after its tunnel exists.
        // Excludes this environment so relinking at the limit stays idempotent.
        const allocation = relayManagedEndpointAllocations;
        const withdrawnLink = (since?: typeof allocation.updatedAt) =>
          exists(
            new QueryBuilder()
              .select({ userId: relayEnvironmentLinks.userId })
              .from(relayEnvironmentLinks)
              .where(
                and(
                  eq(relayEnvironmentLinks.userId, allocation.userId),
                  eq(relayEnvironmentLinks.environmentId, allocation.environmentId),
                  or(
                    isNotNull(relayEnvironmentLinks.revokedAt),
                    eq(relayEnvironmentLinks.managedTunnelsEnabled, false),
                  ),
                  since === undefined ? undefined : gte(relayEnvironmentLinks.updatedAt, since),
                ),
              ),
          );
        const counted = yield* db
          .select({ activeTunnels: count() })
          .from(allocation)
          .where(
            and(
              eq(allocation.userId, input.userId),
              ne(allocation.environmentId, input.environmentId),
              or(
                // Reserved but not yet holding a tunnel. Release writes updatedAt = tunnelReleasedAt and
                // a relink reserves before rewriting its link, so only a newer reservation counts here.
                and(
                  gt(allocation.updatedAt, pendingCutoff),
                  or(
                    isNull(allocation.tunnelReleasedAt),
                    gt(allocation.updatedAt, allocation.tunnelReleasedAt),
                  ),
                  not(withdrawnLink(allocation.updatedAt)),
                ),
                and(
                  isNotNull(allocation.tunnelId),
                  isNull(allocation.tunnelReleasedAt),
                  not(withdrawnLink()),
                ),
              ),
            ),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ManagedTunnelLimitPersistenceError({
                  operation: "count-tunnels",
                  userId: input.userId,
                  cause,
                }),
            ),
          );
        const activeTunnels = counted[0]?.activeTunnels ?? 0;

        if (activeTunnels >= maxTunnels) {
          return yield* new ManagedTunnelLimitExceeded({
            userId: input.userId,
            environmentId: input.environmentId,
            maxTunnels,
            activeTunnels,
          });
        }
        return yield* reserve;
      });

      // Statements inside map their own SqlErrors, so any left here come from opening or committing the transaction.
      return yield* db.$client.withTransaction(checkAndReserve).pipe(
        Effect.mapError((cause) =>
          SqlError.isSqlError(cause)
            ? new ManagedTunnelLimitPersistenceError({
                operation: "transaction",
                userId: input.userId,
                cause,
              })
            : cause,
        ),
      );
    }),
  });
});

export const layer = Layer.effect(ManagedTunnelLimits, make);
