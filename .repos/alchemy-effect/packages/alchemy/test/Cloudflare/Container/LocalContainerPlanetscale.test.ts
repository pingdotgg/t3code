import * as Cloudflare from "@/Cloudflare";
import * as Planetscale from "@/Planetscale";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import { expectDatabaseReachable } from "./fixtures/sqlreach/expect.ts";
import PlanetscaleHostStack from "./fixtures/pshost/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.merge(Cloudflare.providers(), Planetscale.providers()),
  state: Cloudflare.state(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 240_000;

/**
 * PlanetScale is mode-agnostic like Neon: `alchemy dev` still points the
 * container at `*.psdb.cloud` (pooled PSBouncer). Same #1334 path as Prisma
 * and Neon — rewrite must be a no-op, TCP from the container must succeed.
 */
describe.skipIf(!process.env.PLANETSCALE_TEST)(
  "local container reaches PlanetScale Postgres",
  () => {
    const stack = beforeAll(deploy(PlanetscaleHostStack), {
      timeout: HOOK_TIMEOUT,
    });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(PlanetscaleHostStack), {
      timeout: HOOK_TIMEOUT,
    });

    test(
      "container DATABASE_URL keeps the PlanetScale host and reaches it",
      Effect.gen(function* () {
        const { url } = yield* stack;
        yield* expectDatabaseReachable(url, (hostname) => {
          expect(hostname).not.toBe("localhost");
          expect(hostname).not.toBe("127.0.0.1");
          expect(hostname).not.toContain("host.docker.localhost");
          expect(hostname).toMatch(/psdb\.cloud$/);
        });
      }).pipe(logLevel),
      { timeout: TEST_TIMEOUT },
    );
  },
);
