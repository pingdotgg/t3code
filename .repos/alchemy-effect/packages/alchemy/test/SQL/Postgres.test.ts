import * as Cloudflare from "@/Cloudflare";
import * as Neon from "@/Neon";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { exerciseSqlSurface, postJson, putJson } from "./exercise.ts";
import type { UserRow } from "./fixtures/routes.ts";
import Stack from "./fixtures/postgres-stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.merge(Cloudflare.providers(), Neon.providers()),
  state: Cloudflare.state(),
});

const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 120_000;

/**
 * End-to-end test of `SQL.Postgres` — the raw `@effect/sql-pg` client
 * wrapped in alchemy's deferred `proxyChain` — against a real Cloudflare
 * Worker fronting a Neon Postgres origin through Hyperdrive (caching
 * disabled for read-after-write assertions).
 *
 * Runs the same shared exercise as the D1 suite, plus the Postgres-only
 * surface: `withTransaction` (commit + rollback) and multi-row
 * `sql.updateValues`.
 */
const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: HOOK_TIMEOUT,
});

test(
  "SQL.Postgres exercises the full client surface over a deployed Worker",
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

    // sql.updateValues — multi-row update through a VALUES join.
    const daveV2: UserRow = {
      id: 10,
      name: "david",
      email: "david@example.com",
    };
    const erinV2: UserRow = {
      id: 11,
      name: "erina",
      email: "erina@example.com",
    };
    const updated = (yield* putJson(`${url}/users/values`, [
      daveV2,
      erinV2,
    ])) as { rows: UserRow[] };
    expect(updated.rows).toEqual([daveV2, erinV2]);
  }),
  { timeout: TEST_TIMEOUT },
);
