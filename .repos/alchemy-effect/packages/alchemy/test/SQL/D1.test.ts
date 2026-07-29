import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import * as Effect from "effect/Effect";
import { exerciseSqlSurface } from "./exercise.ts";
import Stack from "./fixtures/d1-stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 120_000;

/**
 * End-to-end test of `SQL.D1` — the raw `@effect/sql-d1` client wrapped in
 * alchemy's deferred `proxyChain` — against a real Cloudflare Worker + D1
 * database. The shared exercise drives every `SqlClient` constructor helper
 * the D1 driver supports (transactions and `updateValues` are not supported
 * by `@effect/sql-d1`); because the client is proxyChain-wrapped, every
 * nested helper (`sql.insert`, `sql.and`, `sql.in`, `sql.csv`, identifiers)
 * also regression-tests deferred-proxy replay.
 */
const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: HOOK_TIMEOUT,
});

test(
  "SQL.D1 exercises the full client surface over a deployed Worker",
  Effect.gen(function* () {
    const { url } = yield* stack;
    yield* exerciseSqlSurface(url);
  }),
  { timeout: TEST_TIMEOUT },
);
