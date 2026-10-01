import * as Cloudflare from "@/Cloudflare";
import * as Planetscale from "@/Planetscale";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { exerciseSqlSurface, postJson } from "./exercise.ts";
import type { UserRow } from "./fixtures/routes.ts";
import Stack from "./fixtures/mysql-stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.merge(Cloudflare.providers(), Planetscale.providers()),
  state: Cloudflare.state(),
});

// PlanetScale database provisioning dominates the deploy.
const HOOK_TIMEOUT = 900_000;
const TEST_TIMEOUT = 120_000;

/**
 * End-to-end test of `SQL.MySQL` — the raw `@effect/sql-mysql2` client
 * wrapped in alchemy's deferred `proxyChain` — against a real Cloudflare
 * Worker fronting a PlanetScale MySQL origin through Hyperdrive (caching
 * disabled for read-after-write assertions).
 *
 * Runs the same shared exercise as the D1/Postgres suites, plus the
 * transaction surface: `withTransaction` (commit + rollback). Also pins the
 * Workers-specific client defaults — text protocol (Hyperdrive's MySQL
 * proxy has no `COM_STMT_PREPARE`) and eval-free row parsing (workerd
 * forbids runtime code generation) — since every route would fail without
 * them.
 */
describe.skipIf(!process.env.PLANETSCALE_TEST)("SQL.MySQL", () => {
  const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
    timeout: HOOK_TIMEOUT,
  });

  test(
    "SQL.MySQL exercises the full client surface over a deployed Worker",
    Effect.gen(function* () {
      const { url } = yield* stack;
      yield* exerciseSqlSurface(url);

      // withTransaction — both inserts commit atomically.
      const dave: UserRow = { id: 10, name: "dave", email: "dave@example.com" };
      const erin: UserRow = { id: 11, name: "erin", email: "erin@example.com" };
      const committed = (yield* postJson(`${url}/tx/commit`, [dave, erin])) as {
        rows: UserRow[];
      };
      expect(committed.rows).toEqual([dave, erin]);

      // withTransaction — a failing effect rolls the insert back.
      const rolledBack = (yield* postJson(`${url}/tx/rollback`, {
        id: 12,
        name: "frank",
        email: "frank@example.com",
      })) as { error: string; rows: unknown[] };
      expect(rolledBack.error).toBe("Rollback");
      expect(rolledBack.rows).toEqual([]);
    }),
    { timeout: TEST_TIMEOUT },
  );
});
