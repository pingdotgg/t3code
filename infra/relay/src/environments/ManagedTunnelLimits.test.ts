import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { ne } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { RelayT3ChatPlan } from "@t3tools/contracts/relay";

import * as RelayDb from "../db.ts";
import { relayManagedEndpointAllocations } from "../persistence/schema.ts";
import * as T3ChatAccounts from "../t3chat/T3ChatAccounts.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

const BACKFILL_MIGRATION = "20261028062605_backfill_withdrawn_tunnel_allocations";

class FakeTransaction extends Context.Service<FakeTransaction, { holdsLock: boolean }>()(
  "t3code-relay/environments/ManagedTunnelLimits.test/FakeTransaction",
) {}

interface FakeDbInput {
  readonly otherSlots: () => number;
  readonly ownSlot?: boolean;
  readonly override?: number;
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

  it.effect("counts each allocation by its tunnel and link state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pg = yield* Effect.acquireRelease(
        Effect.promise(() => PGlite.create()),
        (client) => Effect.promise(() => client.close()),
      );
      const migrationsDir = new URL("../../migrations/postgres/", import.meta.url).pathname;
      const migrations = (yield* fs.readDirectory(migrationsDir)).toSorted();
      const applyMigrations = (names: ReadonlyArray<string>) =>
        Effect.forEach(names, (name) =>
          fs
            .readFileString(`${migrationsDir}${name}/migration.sql`)
            .pipe(Effect.flatMap((migration) => Effect.promise(() => pg.exec(migration)))),
        );
      const backfill = migrations.indexOf(BACKFILL_MIGRATION);
      expect(backfill).toBeGreaterThan(-1);
      yield* applyMigrations(migrations.slice(0, backfill));

      const at = (minutes: number) => `2026-10-27T12:${String(minutes).padStart(2, "0")}:00.000Z`;
      const cases: ReadonlyArray<{
        readonly environmentId: string;
        readonly counted: boolean;
        readonly allocation: {
          readonly tunnelId?: string;
          readonly releasedAt?: number;
          readonly updatedAt: number;
        };
        readonly link?: {
          readonly revoked?: boolean;
          readonly publishOnly?: boolean;
          readonly updatedAt: number;
        };
      }> = [
        { environmentId: "pending", counted: true, allocation: { updatedAt: 50 } },
        { environmentId: "abandoned-reservation", counted: false, allocation: { updatedAt: 10 } },
        {
          environmentId: "live",
          counted: true,
          allocation: { tunnelId: "t", updatedAt: 10 },
          link: { updatedAt: 12 },
        },
        {
          environmentId: "released",
          counted: false,
          allocation: { tunnelId: "t", releasedAt: 20, updatedAt: 20 },
        },
        {
          environmentId: "re-reserved-after-release",
          counted: true,
          allocation: { tunnelId: "t", releasedAt: 20, updatedAt: 50 },
        },
        {
          environmentId: "revoked",
          counted: false,
          allocation: { tunnelId: "t", updatedAt: 10 },
          link: { revoked: true, updatedAt: 20 },
        },
        {
          environmentId: "revoked-pending",
          counted: false,
          allocation: { updatedAt: 50 },
          link: { revoked: true, updatedAt: 55 },
        },
        {
          environmentId: "publish-only",
          counted: false,
          allocation: { tunnelId: "t", updatedAt: 10 },
          link: { publishOnly: true, updatedAt: 20 },
        },
        // Reprovisioned after a revoke, but the Worker died before rewriting the link.
        {
          environmentId: "reprovision-before-link",
          counted: true,
          allocation: { tunnelId: "t", updatedAt: 20 },
          link: { revoked: true, updatedAt: 10 },
        },
        {
          environmentId: "reserved-before-link-rewrite",
          counted: true,
          allocation: { updatedAt: 50 },
          link: { revoked: true, updatedAt: 48 },
        },
        // Tunnel deleted but the row survived; deprovision marked it released, then a relink stalled.
        {
          environmentId: "released-after-failed-removal-then-reserved",
          counted: false,
          allocation: { tunnelId: "t", releasedAt: 20, updatedAt: 30 },
          link: { revoked: true, updatedAt: 15 },
        },
        {
          environmentId: "withdrawn-at-provisioning-write",
          counted: false,
          allocation: { tunnelId: "t", updatedAt: 20 },
          link: { revoked: true, updatedAt: 20 },
        },
        { environmentId: "self", counted: false, allocation: { tunnelId: "t", updatedAt: 10 } },
      ];
      // Written before the deploy: claimDeprovision bumped updatedAt past the revoke, then cleanup failed.
      const legacyCases: typeof cases = [
        {
          environmentId: "legacy-failed-deprovision",
          counted: false,
          allocation: { tunnelId: "t", updatedAt: 30 },
          link: { revoked: true, updatedAt: 20 },
        },
        {
          environmentId: "legacy-failed-publish-only-deprovision",
          counted: false,
          allocation: { tunnelId: "t", updatedAt: 30 },
          link: { publishOnly: true, updatedAt: 20 },
        },
        {
          environmentId: "legacy-live",
          counted: true,
          allocation: { tunnelId: "t", updatedAt: 30 },
          link: { updatedAt: 20 },
        },
      ];
      const insert = (entries: typeof cases) =>
        Effect.forEach(entries, (entry) =>
          Effect.promise(async () => {
            await pg.query(
              `insert into relay_managed_endpoint_allocations
                (user_id, environment_id, hostname, tunnel_id, tunnel_name, tunnel_released_at, created_at, updated_at)
                values ('user-1', $1::text, $1::text, $2, $1::text, $3, $4, $4)`,
              [
                entry.environmentId,
                entry.allocation.tunnelId ?? null,
                entry.allocation.releasedAt === undefined ? null : at(entry.allocation.releasedAt),
                at(entry.allocation.updatedAt),
              ],
            );
            const link = entry.link;
            if (link !== undefined) {
              await pg.query(
                `insert into relay_environment_links
                  (user_id, environment_id, environment_public_key, endpoint_http_base_url,
                   endpoint_ws_base_url, endpoint_provider_kind, revoked_at, managed_tunnels_enabled,
                   created_at, updated_at)
                  values ('user-1', $1, 'key', 'https://e', 'wss://e', 'cloudflare_tunnel', $2, $3, $4, $4)`,
                [
                  entry.environmentId,
                  link.revoked === true ? at(link.updatedAt) : null,
                  link.publishOnly !== true,
                  at(link.updatedAt),
                ],
              );
            }
          }),
        );
      yield* insert(legacyCases);
      yield* applyMigrations(migrations.slice(backfill));
      yield* insert(cases);
      yield* Effect.promise(() =>
        pg.query(
          `insert into relay_managed_endpoint_allocations
            (user_id, environment_id, hostname, tunnel_id, tunnel_name, created_at, updated_at)
            values ('user-2', 'other-user', 'other-user', 't', 'other-user', $1, $1)`,
          [at(10)],
        ),
      );

      const counted = yield* Effect.promise(() =>
        drizzle({ client: pg })
          .select({ environmentId: relayManagedEndpointAllocations.environmentId })
          .from(relayManagedEndpointAllocations)
          .where(
            ManagedTunnelLimits.countedAllocations({
              userId: "user-1",
              environmentId: "self",
              pendingCutoff: at(45),
              environment: ne,
            }),
          ),
      );

      expect(counted.map((row) => row.environmentId).toSorted()).toEqual(
        [...legacyCases, ...cases]
          .filter((entry) => entry.counted)
          .map((entry) => entry.environmentId)
          .toSorted(),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

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
