import { and, count, eq, isNull, ne } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import {
  relayEnvironmentLinks,
  relayManagedEndpointAllocations,
  relayManagedTunnelLimits,
} from "../persistence/schema.ts";

/**
 * Managed tunnels a user may hold at once unless a row in
 * `relay_managed_tunnel_limits` overrides it for that user.
 */
export const DEFAULT_MANAGED_TUNNEL_LIMIT = 3;

export class ManagedTunnelLimitPersistenceError extends Schema.TaggedErrorClass<ManagedTunnelLimitPersistenceError>()(
  "ManagedTunnelLimitPersistenceError",
  {
    operation: Schema.Literals(["load-limit", "count-tunnels"]),
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Managed tunnel limit '${this.operation}' failed for user '${this.userId}'`;
  }
}

export class ManagedTunnelLimitExceeded extends Schema.TaggedErrorClass<ManagedTunnelLimitExceeded>()(
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
    readonly ensureCapacity: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<void, ManagedTunnelLimitExceeded | ManagedTunnelLimitPersistenceError>;
  }
>()("t3code-relay/environments/ManagedTunnelLimits") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return ManagedTunnelLimits.of({
    ensureCapacity: Effect.fn("relay.managed_tunnel_limits.ensure_capacity")(function* (input) {
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

      // Allocations already held for this environment are excluded so that
      // re-linking an environment the user already has a tunnel for stays
      // idempotent even when the account is at its limit.
      const counted = yield* db
        .select({ activeTunnels: count() })
        .from(relayManagedEndpointAllocations)
        .innerJoin(
          relayEnvironmentLinks,
          and(
            eq(relayEnvironmentLinks.userId, relayManagedEndpointAllocations.userId),
            eq(relayEnvironmentLinks.environmentId, relayManagedEndpointAllocations.environmentId),
          ),
        )
        .where(
          and(
            eq(relayManagedEndpointAllocations.userId, input.userId),
            ne(relayManagedEndpointAllocations.environmentId, input.environmentId),
            isNull(relayEnvironmentLinks.revokedAt),
            eq(relayEnvironmentLinks.managedTunnelsEnabled, true),
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
    }),
  });
});

export const layer = Layer.effect(ManagedTunnelLimits, make);
