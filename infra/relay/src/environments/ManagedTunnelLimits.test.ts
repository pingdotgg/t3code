import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { PgDialect } from "drizzle-orm/pg-core";
import type { RelayT3ChatPlan } from "@t3tools/contracts/relay";

import * as RelayDb from "../db.ts";
import { relayManagedEndpointAllocations } from "../persistence/schema.ts";
import * as T3ChatAccounts from "../t3chat/T3ChatAccounts.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

class FakeTransaction extends Context.Service<FakeTransaction, { holdsLock: boolean }>()(
  "t3code-relay/environments/ManagedTunnelLimits.test/FakeTransaction",
) {}

interface FakeDbInput {
  readonly otherSlots: () => number;
  readonly ownSlot?: boolean;
  readonly override?: number;
  readonly countConditions?: Array<unknown>;
}

// Models Postgres just enough: the advisory lock only works inside a transaction and is held until it ends.
function makeFakeDb(input: FakeDbInput) {
  const userLock = Semaphore.makeUnsafe(1);
  const dialect = new PgDialect();
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
            return {
              limit: () =>
                Effect.succeed(
                  input.override === undefined ? [] : [{ maxTunnels: input.override }],
                ),
            };
          }
          input.countConditions?.push(condition);
          const countsOthers = dialect
            .sqlToQuery(condition as never)
            .sql.includes('"relay_managed_endpoint_allocations"."environment_id" <>');
          return Effect.yieldNow.pipe(
            Effect.andThen(
              Effect.sync(() => [
                { slots: countsOthers ? input.otherSlots() : input.ownSlot ? 1 : 0 },
              ]),
            ),
          );
        },
      }),
    }),
  } as unknown as RelayDb.RelayDb["Service"];
}

const t3ChatLayer = (plan: RelayT3ChatPlan | "lookup-fails", lookups?: Array<string>) =>
  Layer.mock(T3ChatAccounts.T3ChatAccounts, {
    available: true,
    getLink: ({ userId }) => {
      lookups?.push(userId);
      return plan === "lookup-fails"
        ? Effect.fail(
            new T3ChatAccounts.T3ChatRequestFailed({
              operation: "get-link",
              cause: new Error("down"),
            }),
          )
        : Effect.succeed({ email: "theo@example.com", plan });
    },
  });

const reserve = (
  input: Omit<FakeDbInput, "otherSlots"> & {
    readonly activeTunnels: number;
    readonly plan: RelayT3ChatPlan | "lookup-fails";
    readonly lookups?: Array<string>;
  },
) =>
  Effect.gen(function* () {
    const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
    return yield* limits.withCapacity({ userId: "user-1", environmentId: "env-new" }, Effect.void);
  }).pipe(
    Effect.provide(
      ManagedTunnelLimits.layer.pipe(
        Layer.provide(
          Layer.succeed(
            RelayDb.RelayDb,
            makeFakeDb({ ...input, otherSlots: () => input.activeTunnels }),
          ),
        ),
        Layer.provide(t3ChatLayer(input.plan, input.lookups)),
      ),
    ),
  );

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
          Layer.provide(
            Layer.succeed(RelayDb.RelayDb, makeFakeDb({ otherSlots: () => reserved.length })),
          ),
          Layer.provide(t3ChatLayer("free")),
        ),
      ),
    );
  });

  it.effect("pending reservations stop counting once released or withdrawn", () => {
    const countConditions: Array<unknown> = [];

    return Effect.gen(function* () {
      yield* reserve({ activeTunnels: 0, plan: "free", countConditions });

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
    });
  });

  it.effect("does not ask T3 Chat while the account is under its cap", () =>
    Effect.gen(function* () {
      const lookups: Array<string> = [];
      yield* reserve({ activeTunnels: 2, plan: "free", lookups });
      expect(lookups).toEqual([]);
    }),
  );

  it.effect("raises the cap to the linked T3 Chat plan's limit", () =>
    Effect.gen(function* () {
      for (const [plan, limit] of [
        ["pro", 10],
        ["premier", 100],
      ] as const) {
        yield* reserve({ activeTunnels: limit - 1, plan });
        const error = yield* Effect.flip(reserve({ activeTunnels: limit, plan }));
        expect(error).toMatchObject({ _tag: "ManagedTunnelLimitExceeded", maxTunnels: limit });
      }
    }),
  );

  it.effect("keeps the default cap for free plans and failed lookups", () =>
    Effect.gen(function* () {
      for (const plan of ["free", "lookup-fails"] as const) {
        const error = yield* Effect.flip(reserve({ activeTunnels: 3, plan }));
        expect(error).toMatchObject({ _tag: "ManagedTunnelLimitExceeded", maxTunnels: 3 });
      }
    }),
  );

  it.effect("treats a manual override as the exact cap", () =>
    Effect.gen(function* () {
      const lookups: Array<string> = [];
      for (const override of [1, 200]) {
        const error = yield* Effect.flip(
          reserve({ override, activeTunnels: override, plan: "premier", lookups }),
        );
        expect(error).toMatchObject({ _tag: "ManagedTunnelLimitExceeded", maxTunnels: override });
      }
      expect(lookups).toEqual([]);
    }),
  );

  it.effect("lets an environment holding a slot relink without asking T3 Chat", () =>
    Effect.gen(function* () {
      const lookups: Array<string> = [];
      yield* reserve({ activeTunnels: 10, plan: "lookup-fails", ownSlot: true, lookups });
      expect(lookups).toEqual([]);
    }),
  );
});
