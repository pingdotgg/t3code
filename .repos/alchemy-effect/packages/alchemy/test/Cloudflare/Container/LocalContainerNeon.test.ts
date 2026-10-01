import * as Cloudflare from "@/Cloudflare";
import * as Neon from "@/Neon";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import { expectDatabaseReachable } from "./fixtures/sqlreach/expect.ts";
import NeonHostStack from "./fixtures/neonhost/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.merge(Cloudflare.providers(), Neon.providers()),
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
 * Neon is mode-agnostic: `alchemy dev` still hands the container a cloud
 * `*.neon.tech` URL. The loopback rewrite must not touch it, and with
 * `enableInternet` the container must be able to dial it — the same
 * #1334 "container reaches a SQL database" path as Prisma, minus a local
 * emulator.
 */
describe("local container reaches Neon Postgres", () => {
  const stack = beforeAll(deploy(NeonHostStack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(NeonHostStack), {
    timeout: HOOK_TIMEOUT,
  });

  test(
    "container DATABASE_URL keeps the Neon host and reaches it",
    Effect.gen(function* () {
      const { url } = yield* stack;
      yield* expectDatabaseReachable(url, (hostname) => {
        expect(hostname).not.toBe("localhost");
        expect(hostname).not.toBe("127.0.0.1");
        expect(hostname).not.toContain("host.docker.localhost");
        expect(hostname).toMatch(/neon\.tech$/);
      });
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );
});
