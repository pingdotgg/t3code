import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
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

// Deterministic tunnel names: identical on every run so a crashed run never
// leaks a uniquely-named tunnel. The fixture routes purge any leftover tunnel
// with the same name before creating, making each run self-healing.
const writeName = "alchemy-tunnel-test-write";
const readWriteName = "alchemy-tunnel-test-readwrite";

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
        `${effectUrl}/write?name=${encodeURIComponent(writeName)}`,
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
      const name = readWriteName;
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

// Canonical `list()` test (account collection): deploy a tunnel, resolve the
// provider with the typed `Provider.findProvider`, enumerate every cfd_tunnel
// in the account, and assert the deployed tunnel is present. Bracket with
// `stack.destroy()` so the test is isolated and leaves no cloud residue.
describe("Tunnel.list", () => {
  test.provider("list enumerates the deployed tunnel", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Tunnel.Tunnel("ListTunnel");
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.Tunnel.Tunnel);
      const all = yield* provider.list();

      expect(all.some((t) => t.tunnelId === deployed.tunnelId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  );
});
