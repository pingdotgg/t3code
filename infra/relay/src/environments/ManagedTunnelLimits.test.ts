import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { PgDialect } from "drizzle-orm/pg-core";

import * as RelayDb from "../db.ts";
import { relayManagedEndpointAllocations } from "../persistence/schema.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

class FakeTransaction extends Context.Service<FakeTransaction, { holdsLock: boolean }>()(
  "t3code-relay/environments/ManagedTunnelLimits.test/FakeTransaction",
) {}

// Models Postgres just enough: the advisory lock only works inside a transaction and is held until it ends.
function makeFakeDb(reserved: ReadonlyArray<unknown>, countConditions: Array<unknown> = []) {
  const userLock = Semaphore.makeUnsafe(1);
  return {
    $client: {
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => {
        const transaction = { holdsLock: false };
        return effect.pipe(
          Effect.provideService(FakeTransaction, transaction),
          Effect.ensuring(
            Effect.suspend(() => (transaction.holdsLock ? userLock.release(1) : Effect.void)),
          ),
        );
      },
    },
    execute: () =>
      Effect.gen(function* () {
        const transaction = yield* Effect.serviceOption(FakeTransaction);
        if (transaction._tag === "None") {
          return yield* Effect.die("advisory lock taken outside a transaction");
        }
        yield* userLock.take(1);
        transaction.value.holdsLock = true;
        return [];
      }),
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => {
          if (table !== relayManagedEndpointAllocations) {
            return { limit: () => Effect.succeed([]) };
          }
          countConditions.push(condition);
          return Effect.yieldNow.pipe(Effect.as([{ activeTunnels: reserved.length }]));
        },
      }),
    }),
  } as unknown as RelayDb.RelayDb["Service"];
}

describe("ManagedTunnelLimits", () => {
  it.effect("rejects concurrent reservations past the limit", () => {
    const reserved: Array<string> = [];
    const attempts = ManagedTunnelLimits.DEFAULT_MANAGED_TUNNEL_LIMIT + 2;

    return Effect.gen(function* () {
      const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
      const results = yield* Effect.forEach(
        Array.from({ length: attempts }, (_, index) => `environment-${index}`),
        (environmentId) =>
          limits
            .withCapacity(
              { userId: "user-1", environmentId },
              Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => reserved.push(environmentId)))),
            )
            .pipe(Effect.result),
        { concurrency: "unbounded" },
      );

      expect(reserved).toHaveLength(ManagedTunnelLimits.DEFAULT_MANAGED_TUNNEL_LIMIT);
      expect(
        results.filter(
          (result) =>
            result._tag === "Failure" && result.failure._tag === "ManagedTunnelLimitExceeded",
        ),
      ).toHaveLength(2);
    }).pipe(
      Effect.provide(
        ManagedTunnelLimits.layer.pipe(
          Layer.provide(Layer.succeed(RelayDb.RelayDb, makeFakeDb(reserved))),
        ),
      ),
    );
  });

  it.effect("pending reservations stop counting once released or withdrawn", () => {
    const countConditions: Array<unknown> = [];

    return Effect.gen(function* () {
      const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
      yield* limits.withCapacity({ userId: "user-1", environmentId: "environment-1" }, Effect.void);

      expect(countConditions).toHaveLength(1);
      const query = new PgDialect().sqlToQuery(countConditions[0] as never);
      // claimRelease writes updatedAt = tunnelReleasedAt; a later reserve moves updatedAt past it.
      expect(query.sql).toContain(
        '"relay_managed_endpoint_allocations"."updated_at" > "relay_managed_endpoint_allocations"."tunnel_released_at"',
      );
      // A link revoked or made publish-only after the last reservation no longer holds a slot.
      expect(query.sql).toContain(
        '"relay_environment_links"."updated_at" >= "relay_managed_endpoint_allocations"."updated_at"',
      );
    }).pipe(
      Effect.provide(
        ManagedTunnelLimits.layer.pipe(
          Layer.provide(Layer.succeed(RelayDb.RelayDb, makeFakeDb([], countConditions))),
        ),
      ),
    );
  });
});
