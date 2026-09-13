import * as Cloudflare from "@/Cloudflare";
import * as Prisma from "@/Prisma";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import PrismaHostStack from "./fixtures/prismahost/stack.ts";
import { expectDatabaseReachable } from "./fixtures/sqlreach/expect.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.merge(Cloudflare.providers(), Prisma.providers()),
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
 * Regression for alchemy-run/alchemy#1334 on Linux: an arbitrary image given
 * a local Prisma `DATABASE_URL` (`postgres://…@127.0.0.1:…`) must be able to
 * reach `@prisma/dev` from inside the container. host-gateway rewrites the
 * hostname, but the server still has to accept connections on the Docker
 * bridge — a 127.0.0.1 listener times out with
 * `dial error: timeout` to `172.17.0.1`.
 */
describe("local container reaches Prisma Postgres", () => {
  const stack = beforeAll(deploy(PrismaHostStack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(PrismaHostStack), {
    timeout: HOOK_TIMEOUT,
  });

  test(
    "container DATABASE_URL is rewritten once and reaches the host Prisma",
    Effect.gen(function* () {
      const { url } = yield* stack;
      yield* expectDatabaseReachable(url, (hostname) => {
        expect(hostname).not.toBe("localhost");
        expect(hostname).not.toBe("127.0.0.1");
        expect(hostname).toContain("localhost");
      });
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );
});
