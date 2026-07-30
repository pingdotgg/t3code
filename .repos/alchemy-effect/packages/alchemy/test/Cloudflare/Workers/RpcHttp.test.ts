import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { WorkerRpcs } from "./fixtures/rpc-http/group.ts";
import Stack from "./fixtures/rpc-http/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

// `Test.rpcClientLayer` guards the transport against edge-generated HTML
// bodies (the workers.dev placeholder — which serves with HTTP 200 —
// 1101/1102 error pages, 429/1015 rate limits): the effect RPC HTTP protocol
// never inspects status or content-type, so those would otherwise surface as
// an opaque `RpcClientDefect: Error decoding HTTP response`. Non-ndjson
// responses fail typed (status + body snippet) and are retried at the
// transport level, so every RPC call in this file rides out edge-propagation
// windows with one shared budget.
const clientLayer = Test.rpcClientLayer;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Cap exponential backoff at 3s so readiness retries poll densely instead of
// sleeping tens of seconds past the propagation window (an uncapped
// exponential blows through the 30s test timeouts after ~6 attempts).
const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

// The worker fixture wraps the DO calls in `Effect.orDie` / `Stream.orDie`,
// so a transient `Worker not found.` (the worker→DO namespace binding hasn't
// propagated to every Cloudflare edge yet) can arrive at the client as a
// DEFECT — and `Effect.retry` does not retry defects. Promote defects to
// failures so the readiness retry can absorb the propagation window (a
// genuine bug simply keeps failing until the retry budget is exhausted).
const retryReadyN =
  (times: number) =>
  <A, E, R>(eff: Effect.Effect<A, E, R>) =>
    eff.pipe(
      Effect.catchDefect((defect) => Effect.fail(defect)),
      Effect.retry({ schedule: readinessSchedule, times }),
    );

const retryReady = retryReadyN(15);

const stack = beforeAll(
  deploy(Stack).pipe(
    // Ping the Worker to ensure it's ready.
    // Subsequent calls should succeed without retries.
    Effect.tap(({ url }) =>
      Effect.gen(function* () {
        const client = yield* RpcClient.make(WorkerRpcs);
        const result = yield* client.Ping({ message: "warmup" }).pipe(
          Effect.tapError(Console.log),
          Effect.retry({
            schedule: Schedule.min([
              Schedule.exponential("500 millis"),
              Schedule.spaced("3 seconds"),
            ]),
            times: 12,
          }),
        );
        expect(result.echo).toBe("warmup");
        expect(result.n).toBeGreaterThan(0);
      }).pipe(Effect.scoped, Effect.provide(clientLayer(url))),
    ),
    // Gate on the worker→DO pathway too: under full-suite parallel load the
    // DO namespace binding propagates noticeably slower than the worker
    // itself, and the `*DO` tests below would otherwise race that window.
    Effect.tap(({ url }) =>
      Effect.gen(function* () {
        const client = yield* RpcClient.make(WorkerRpcs);
        yield* client.PingDO({ message: "warmup" }).pipe(retryReady);
        yield* client.CountDO({ upto: 1 }).pipe(Stream.runCollect, retryReady);
      }).pipe(Effect.scoped, Effect.provide(clientLayer(url))),
    ),
    // Let edge propagation settle before the (mostly un-retried) bodies run.
    Effect.tap(() => Effect.sleep("5 seconds")),
  ),
  { timeout: 180_000 },
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// The Cloudflare Worker fetch adapter (`workersHttpHandler`) currently
// short-circuits Effect's standard HTTP lifecycle (it manually
// provides `HttpServerRequest` and converts the response to a web
// `Response` outside of `HttpEffect.toHandled`). PR #328 reported that
// this can deadlock `RpcServer.toHttpEffect` under workerd. This test
// hammers a real deployed Worker exposing an Effect RPC group to
// surface lifecycle / per-request scope regressions.
//
// The `*DO` variants exercise the DO fetch pathway
// (`DurableObjectBridge.fetch` -> `makeRequestEffect`) via an
// `RpcClient` constructed inside the Worker handler whose transport
// is `Cloudflare.toHttpClient(rpcDO.getByName(...))`. This mirrors the
// HttpApi fixture's `getTaskDO` pattern.
test(
  "RpcServer.toHttpEffect: unary RPC response",
  Effect.gen(function* () {
    const { url } = yield* stack;
    yield* Effect.log("url:", url);

    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(WorkerRpcs);
      // Even after the warmup gate, a fresh request can land on a PoP that
      // hasn't resolved the script yet and get Cloudflare's HTML error page,
      // which is not valid ndjson (`RpcClientDefect`). `Ping` is idempotent,
      // so retry through a bounded schedule.
      const result = yield* client.Ping({ message: "hello" }).pipe(
        Effect.tapError(Console.log),
        Effect.retry({
          schedule: Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          times: 10,
        }),
      );
      expect(result.echo).toBe("hello");
      expect(result.n).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(clientLayer(url)));
  }).pipe(logLevel),
  { timeout: 30_000 },
);

test(
  "RpcServer.toHttpEffect: streaming RPC response",
  Effect.gen(function* () {
    const { url } = yield* stack;

    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(WorkerRpcs);
      // First streaming call can race edge propagation and hit a Cloudflare
      // HTML error page; retry the whole collect through a bounded schedule.
      const values = yield* client.Count({ upto: 5 }).pipe(
        Stream.runCollect,
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
      expect(values).toEqual([1, 2, 3, 4, 5]);
    }).pipe(Effect.scoped, Effect.provide(clientLayer(url)));
  }).pipe(logLevel),
  { timeout: 30_000 },
);

test(
  "RpcServer.toHttpEffect: array payload streams response items in order",
  Effect.gen(function* () {
    const { url } = yield* stack;

    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(WorkerRpcs);
      const messages = ["a", "b", "c", "d"];
      // First streaming call can race edge propagation and hit a Cloudflare
      // HTML error page; retry the whole collect through a bounded schedule.
      const values = yield* client.Echo({ messages }).pipe(
        Stream.runCollect,
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
      expect(values).toEqual(
        messages.map((message, index) => ({ index, message })),
      );
    }).pipe(Effect.scoped, Effect.provide(clientLayer(url)));
  }).pipe(logLevel),
  { timeout: 30_000 },
);

test(
  "RpcServer.toHttpEffect: 200 concurrent unary calls do not hang",
  Effect.gen(function* () {
    const { url } = yield* stack;

    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(WorkerRpcs);

      const N = 200;
      const results = yield* Effect.forEach(
        Array.from({ length: N }, (_, i) => i),
        (i) =>
          client.Ping({ message: `m-${i}` }).pipe(
            Effect.timeout("5 seconds"),
            // 64-way fan-out opens many fresh connections, each of which can
            // land on an edge host still serving an HTML page after the
            // single-connection warmup succeeded. The transport guard retries
            // those; this outer budget (matching the siblings' capped
            // generosity) backstops timeouts and longer bursts — the previous
            // uncapped `times: 3` (~3.5s window) was the flake.
            Effect.retry({
              schedule: Schedule.min([
                Schedule.exponential("500 millis"),
                Schedule.spaced("2 seconds"),
              ]),
              times: 10,
            }),
          ),
        { concurrency: 64 },
      );

      expect(results).toHaveLength(N);
      for (let i = 0; i < N; i++) {
        expect(results[i].echo).toBe(`m-${i}`);
      }
    }).pipe(Effect.scoped, Effect.provide(clientLayer(url)));
  }).pipe(logLevel),
  { timeout: 60_000 },
);

test(
  "RpcServer.toHttpEffect: concurrent streaming calls do not hang",
  Effect.gen(function* () {
    const { url } = yield* stack;

    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(WorkerRpcs);

      const N = 64;
      const results = yield* Effect.forEach(
        Array.from({ length: N }, (_, i) => i),
        (i) =>
          client.Count({ upto: 3 + (i % 3) }).pipe(
            Stream.runCollect,
            Effect.timeout("5 seconds"),
            // 64 concurrent first-streams all race cold-start: a PoP that
            // hasn't resolved the script yet returns Cloudflare's HTML error
            // page, which is not valid ndjson and surfaces as an
            // `RpcClientDefect` ("Error decoding HTTP response"). Match the
            // single-stream tests' generosity (capped backoff, ~10 attempts)
            // so the whole fan-out rides out propagation.
            Effect.retry({
              schedule: Schedule.min([
                Schedule.exponential("500 millis"),
                Schedule.spaced("2 seconds"),
              ]),
              times: 10,
            }),
          ),
        { concurrency: N },
      );

      expect(results).toHaveLength(N);
      for (let i = 0; i < N; i++) {
        expect(results[i]).toEqual(
          Array.from({ length: 3 + (i % 3) }, (_, n) => n + 1),
        );
      }
    }).pipe(Effect.scoped, Effect.provide(clientLayer(url)));
  }).pipe(logLevel),
  { timeout: 60_000 },
);

// === Durable Object pathway ===
// These exercise the Worker's `*DO` handlers, which proxy through an
// `RpcClient` whose transport is `Cloudflare.toHttpClient(rpcDO.getByName(...))`.

test(
  "RpcServer.toHttpEffect Durable Object unary RPC response",
  Effect.gen(function* () {
    const { url } = yield* stack;

    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(WorkerRpcs);
      // First DO call can race edge propagation and hit a Cloudflare HTML
      // error page (or a `Worker not found.` defect); retry through a
      // bounded, defect-promoting schedule.
      const result = yield* client
        .PingDO({ message: "hello-do" })
        .pipe(Effect.tapError(Console.log), retryReadyN(10));
      expect(result.echo).toBe("hello-do");
      expect(result.n).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(clientLayer(url)));
  }).pipe(logLevel),
  { timeout: 30_000 },
);

test(
  "RpcServer.toHttpEffect Durable Object streaming RPC response",
  Effect.gen(function* () {
    const { url } = yield* stack;

    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(WorkerRpcs);
      // First DO streaming call can race edge propagation and hit a Cloudflare
      // HTML error page (or a `Worker not found.` defect); retry the whole
      // collect through a bounded, defect-promoting schedule.
      const values = yield* client
        .CountDO({ upto: 5 })
        .pipe(Stream.runCollect, retryReadyN(10));
      expect(values).toEqual([1, 2, 3, 4, 5]);
    }).pipe(Effect.scoped, Effect.provide(clientLayer(url)));
  }).pipe(logLevel),
  { timeout: 30_000 },
);

test(
  "RpcServer.toHttpEffect Durable Object array payload streams response items in order",
  Effect.gen(function* () {
    const { url } = yield* stack;

    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(WorkerRpcs);
      const messages = ["a", "b", "c", "d"];
      // First streaming call can race edge propagation and hit a Cloudflare
      // HTML error page (or a `Worker not found.` defect); retry the whole
      // collect through a bounded, defect-promoting schedule.
      const values = yield* client
        .EchoDO({ messages })
        .pipe(Stream.runCollect, retryReadyN(10));
      expect(values).toEqual(
        messages.map((message, index) => ({ index, message })),
      );
    }).pipe(Effect.scoped, Effect.provide(clientLayer(url)));
  }).pipe(logLevel),
  { timeout: 30_000 },
);

test(
  "RpcServer.toHttpEffect Durable Object concurrent unary calls do not hang",
  Effect.gen(function* () {
    const { url } = yield* stack;

    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(WorkerRpcs);

      const N = 64;
      const results = yield* Effect.forEach(
        Array.from({ length: N }, (_, i) => i),
        (i) =>
          client
            .PingDO({ message: `m-${i}` })
            .pipe(Effect.timeout("10 seconds"), retryReadyN(5)),
        { concurrency: 16 },
      );

      expect(results).toHaveLength(N);
      for (let i = 0; i < N; i++) {
        expect(results[i].echo).toBe(`m-${i}`);
      }
    }).pipe(Effect.scoped, Effect.provide(clientLayer(url)));
  }).pipe(logLevel),
  { timeout: 60_000 },
);

test(
  "RpcServer.toHttpEffect Durable Object concurrent streaming calls do not hang",
  Effect.gen(function* () {
    const { url } = yield* stack;

    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(WorkerRpcs);

      const N = 32;
      const results = yield* Effect.forEach(
        Array.from({ length: N }, (_, i) => i),
        (i) =>
          client
            .CountDO({ upto: 3 + (i % 3) })
            .pipe(
              Stream.runCollect,
              Effect.timeout("10 seconds"),
              retryReadyN(5),
            ),
        { concurrency: N },
      );

      expect(results).toHaveLength(N);
      for (let i = 0; i < N; i++) {
        expect(results[i]).toEqual(
          Array.from({ length: 3 + (i % 3) }, (_, n) => n + 1),
        );
      }
    }).pipe(Effect.scoped, Effect.provide(clientLayer(url)));
  }).pipe(logLevel),
  { timeout: 30_000 },
);
