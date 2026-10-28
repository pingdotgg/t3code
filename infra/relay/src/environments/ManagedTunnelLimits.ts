import { and, count, eq, exists, gt, gte, isNotNull, isNull, ne, not, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlError from "effect/sql/SqlError";
import { DEFAULT_MANAGED_TUNNEL_LIMIT, T3CHAT_PLAN_TUNNEL_LIMITS } from "@t3tools/contracts/relay";

import * as RelayDb from "../db.ts";
import {
  relayEnvironmentLinks,
  relayManagedEndpointAllocations,
  relayManagedTunnelLimits,
} from "../persistence/schema.ts";
import * as T3ChatAccounts from "../t3chat/T3ChatAccounts.ts";

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

const allocation = relayManagedEndpointAllocations;

const withdrawnLink = (since: typeof allocation.updatedAt) =>
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
          gte(relayEnvironmentLinks.updatedAt, since),
        ),
      ),
  );

// Counts allocations, not links: a link is written only after its tunnel exists.
// `environment` is `ne` for the user's other environments or `eq` for this one, which relinks without counting itself.
// updatedAt moves only on provisioning writes and release, never on teardown claims, so a link
// withdrawn at or after it means cleanup is owed; an older withdrawal means a relink that never finished.
export const countedAllocations = (input: {
  readonly userId: string;
  readonly environmentId: string;
  readonly pendingCutoff: string;
  readonly environment: typeof eq;
}) =>
  and(
    eq(allocation.userId, input.userId),
    input.environment(allocation.environmentId, input.environmentId),
    or(
      // Reserved but not yet holding a tunnel. Release writes updatedAt = tunnelReleasedAt and
      // a relink reserves before rewriting its link, so only a newer reservation counts here.
      and(
        gt(allocation.updatedAt, input.pendingCutoff),
        or(
          isNull(allocation.tunnelReleasedAt),
          gt(allocation.updatedAt, allocation.tunnelReleasedAt),
        ),
        not(withdrawnLink(allocation.updatedAt)),
      ),
      and(
        isNotNull(allocation.tunnelId),
        isNull(allocation.tunnelReleasedAt),
        not(withdrawnLink(allocation.updatedAt)),
      ),
    ),
  );

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
  const t3Chat = yield* T3ChatAccounts.T3ChatAccounts;

  // Asked only at the cap, so most links never call T3 Chat. Any failure keeps the lower cap.
  const t3ChatTunnelLimit = (userId: string) =>
    t3Chat.getLink({ userId }).pipe(
      Effect.map((link) =>
        link && link.plan !== "free" ? T3CHAT_PLAN_TUNNEL_LIMITS[link.plan] : 0,
      ),
      Effect.catch((error) =>
        Effect.logWarning("T3 Chat plan check failed", { userId, error: error.message }).pipe(
          Effect.as(0),
        ),
      ),
    );

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
        const baseMaxTunnels = overrides[0]?.maxTunnels ?? DEFAULT_MANAGED_TUNNEL_LIMIT;

        const pendingCutoff = DateTime.formatIso(
          DateTime.subtract(yield* DateTime.now, {
            minutes: MANAGED_TUNNEL_PENDING_WINDOW_MINUTES,
          }),
        );
        const countSlots = (environment: typeof eq) =>
          db
            .select({ slots: count() })
            .from(allocation)
            .where(countedAllocations({ ...input, pendingCutoff, environment }))
            .pipe(
              Effect.map((rows) => rows[0]?.slots ?? 0),
              Effect.mapError(
                (cause) =>
                  new ManagedTunnelLimitPersistenceError({
                    operation: "count-tunnels",
                    userId: input.userId,
                    cause,
                  }),
              ),
            );
        const activeTunnels = yield* countSlots(ne);
        if (activeTunnels < baseMaxTunnels) return yield* reserve;

        // An environment that already holds a counted slot relinks without asking T3 Chat,
        // so a downgrade or a T3 Chat outage only blocks new environments.
        if ((yield* countSlots(eq)) > 0) return yield* reserve;

        // A manual override is the exact cap; a T3 Chat plan raises only the default.
        // Runs under the user lock, bounded by the T3 Chat request timeout.
        const maxTunnels =
          t3Chat.available && overrides.length === 0
            ? Math.max(baseMaxTunnels, yield* t3ChatTunnelLimit(input.userId))
            : baseMaxTunnels;
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
