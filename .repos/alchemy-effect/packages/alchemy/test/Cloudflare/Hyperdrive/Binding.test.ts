import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Neon from "@/Neon/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import Stack from "./fixtures/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.merge(Cloudflare.providers(), Neon.providers()),
  state: Cloudflare.state(),
});

const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 120_000;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

// Bounded spaced schedule — caps total wait so a genuine failure surfaces
// fast instead of an uncapped exponential blowing past the test timeout
// while riding out cold-start propagation.
const ready = Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(30)]);

/** Retry an HTTP call until it returns 200 (rides out cold-start 404s). */
const untilOk = <E, R>(
  eff: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>,
) =>
  eff.pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? Effect.succeed(res)
        : res.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(new WorkerNotReady({ status: res.status, body })),
            ),
          ),
    ),
    Effect.retry({
      while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
      schedule: ready,
    }),
  );

interface Meta {
  host: string;
  port: number;
  user: string;
  database: string;
  hasConnectionString: boolean;
  hasPassword: boolean;
  connectionStringProtocol: string;
  connectionStringHost: string;
}

/** GET `${base}/meta` and assert the Hyperdrive binding resolved at runtime. */
const assertMeta = (base: string) =>
  Effect.gen(function* () {
    const res = yield* untilOk(HttpClient.get(`${base}/meta`));
    const meta = (yield* res.json) as unknown as Meta;

    // The binding resolved to a real runtime Hyperdrive object: every field
    // is populated and the connection string is a well-formed Postgres URI
    // pointing at Hyperdrive's local proxy host (NOT the origin host — the
    // proxy is what Workers connect through).
    expect(meta.host).toBeTruthy();
    expect(meta.port).toBeGreaterThan(0);
    expect(meta.user).toBeTruthy();
    expect(meta.database).toBeTruthy();
    expect(meta.hasConnectionString).toBe(true);
    expect(meta.hasPassword).toBe(true);
    expect(meta.connectionStringProtocol).toMatch(/^postgres(ql)?:$/);
    // The connection string host matches the binding's `host` (the local
    // Hyperdrive proxy), proving the parsed URI and discrete fields agree.
    expect(meta.connectionStringHost).toBe(meta.host);
    return meta;
  });

/**
 * Deploys two Workers that bind ONE shared Hyperdrive Connection (fronting a
 * real Neon Postgres origin) via {@link Stack} — the effect-worker
 * (`Cloudflare.Hyperdrive.Connect`) and the async-worker (`env: { HD }`) —
 * then drives each binding flavor over `fetch`, asserting the runtime
 * Hyperdrive object resolves with a well-formed connection string and the
 * discrete host/port/user/database fields.
 *
 * Hyperdrive needs a reachable Postgres origin; the stack provisions one via
 * `Neon.Project`, so the binding is exercised against a real database config.
 */
const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: HOOK_TIMEOUT,
});

// ── Effect-native binding ── `yield* Cloudflare.Hyperdrive.Connect(connection)`
test(
  "effect-worker: Hyperdrive.Connect resolves the runtime binding",
  Effect.gen(function* () {
    const out = yield* stack;
    yield* assertMeta(out.effectWorkerUrl);
  }).pipe(logLevel),
  { timeout: TEST_TIMEOUT },
);

// `raw` escape hatch resolves to the underlying runtime Hyperdrive object.
test(
  "effect-worker: raw escape hatch exposes the runtime Hyperdrive",
  Effect.gen(function* () {
    const out = yield* stack;
    const res = yield* untilOk(HttpClient.get(`${out.effectWorkerUrl}/raw`));
    const raw = (yield* res.json) as {
      host: string;
      port: number;
      user: string;
      database: string;
    };
    expect(raw.host).toBeTruthy();
    expect(raw.port).toBeGreaterThan(0);
    expect(raw.user).toBeTruthy();
    expect(raw.database).toBeTruthy();
  }).pipe(logLevel),
  { timeout: TEST_TIMEOUT },
);

// ── Async (non-Effect) binding ── declared on `env`, resolved by `InferEnv`.
test(
  "async-worker: env.HD exposes the runtime Hyperdrive binding",
  Effect.gen(function* () {
    const out = yield* stack;
    yield* assertMeta(out.asyncWorkerUrl);
  }).pipe(logLevel),
  { timeout: TEST_TIMEOUT },
);
