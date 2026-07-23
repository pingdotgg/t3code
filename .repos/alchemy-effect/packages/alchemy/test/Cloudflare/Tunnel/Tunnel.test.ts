import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "./fixtures/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// Hit a worker route, retrying through fresh-worker edge propagation, and
// decode the JSON body.
const hit = Effect.fn(function* (path: string) {
  const client = yield* HttpClient.HttpClient;
  const res = yield* client.get(path).pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? Effect.succeed(res)
        : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
    ),
    Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 15 }),
  );
  return yield* res.json;
});

const freshName = () =>
  `alchemy-tunnel-test-${Math.random().toString(36).slice(2, 10)}`;

describe("Tunnel runtime bindings", () => {
  test(
    "TunnelRead lists tunnels with a read-scoped token",
    Effect.gen(function* () {
      const { effectUrl } = yield* stack;
      const body = (yield* hit(`${effectUrl}/read`)) as { count: number };
      expect(body.count).toBeTypeOf("number");
    }).pipe(logLevel),
    { timeout: 180_000 },
  );

  test(
    "TunnelWrite creates and deletes a tunnel with a write-scoped token",
    Effect.gen(function* () {
      const { effectUrl } = yield* stack;
      const body = (yield* hit(
        `${effectUrl}/write?name=${encodeURIComponent(freshName())}`,
      )) as { id: string; deleted: boolean };
      expect(body.id).toBeTypeOf("string");
      expect(body.id.length).toBeGreaterThan(0);
      expect(body.deleted).toBe(true);
    }).pipe(logLevel),
    { timeout: 180_000 },
  );

  test(
    "TunnelReadWrite drives the full CRUD surface",
    Effect.gen(function* () {
      const { effectUrl } = yield* stack;
      const name = freshName();
      const body = (yield* hit(
        `${effectUrl}/readwrite?name=${encodeURIComponent(name)}`,
      )) as {
        id: string;
        getName: string;
        count: number;
        updatedName: string;
        hasToken: boolean;
        deleted: boolean;
      };
      expect(body.id.length).toBeGreaterThan(0);
      expect(body.getName).toBe(name);
      expect(body.count).toBeGreaterThan(0);
      expect(body.updatedName).toBe(`${name}-renamed`);
      expect(body.hasToken).toBe(true);
      expect(body.deleted).toBe(true);
    }).pipe(logLevel),
    { timeout: 180_000 },
  );
});
