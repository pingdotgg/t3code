import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { CallerRpcs, TargetRpcs } from "./fixtures/rpc-worker-binding/group.ts";
import Stack from "./fixtures/rpc-worker-binding/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

// `Test.rpcClientLayer` guards the transport against edge-generated HTML
// bodies (workers.dev placeholder, error pages) that the RPC protocol would
// otherwise surface as an opaque `RpcClientDefect`; see Test/Http.ts.
const clientLayer = Test.rpcClientLayer;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Cap exponential backoff at 3s so retries stay bounded when the CF edge is
// slow (otherwise the geometric blow-up dominates wall time).
const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

// The caller worker forwards to the target via the service binding and wraps
// the call in `Effect.orDie` (see fixtures/caller-worker.ts). On a freshly
// deployed worker the service binding hasn't propagated to every Cloudflare
// edge yet, so the first calls fail with `Worker not found.` — which arrives
// at the client as a DEFECT, and `Effect.retry` does not retry defects.
// Promote defects to failures so the readiness retry can absorb the transient
// binding-propagation error (a genuine bug would simply keep failing until the
// retry budget is exhausted).
const retryReadyN =
  (times: number) =>
  <A, E, R>(eff: Effect.Effect<A, E, R>) =>
    eff.pipe(
      Effect.catchDefect((defect) => Effect.fail(defect)),
      Effect.retry({ schedule: readinessSchedule, times }),
    );

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "RpcWorker: target worker exposes Greet",
  Effect.gen(function* () {
    const { targetUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(TargetRpcs);
      const result = yield* client.Greet({ name: "world" }).pipe(
        Effect.tapError(Console.log),
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 5,
        }),
      );
      expect(result.greeting).toBe("hello world");
    }).pipe(Effect.scoped, Effect.provide(clientLayer(targetUrl)));
  }).pipe(logLevel),
  { timeout: 60_000 },
);

test(
  "RpcWorker.bind: caller proxies through service binding to target",
  Effect.gen(function* () {
    const { callerUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(CallerRpcs);
      const result = yield* client
        .ProxyGreet({ name: "alchemy" })
        .pipe(Effect.tapError(Console.log), retryReadyN(10));
      expect(result.greeting).toBe("hello alchemy");
    }).pipe(Effect.scoped, Effect.provide(clientLayer(callerUrl)));
  }).pipe(logLevel),
  { timeout: 60_000 },
);

test(
  "RpcWorker.bind: 100 concurrent ProxyGreet calls do not hang",
  Effect.gen(function* () {
    const { callerUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(CallerRpcs);

      // Warm the service binding by serially exercising it before the
      // burst — workerd surfaces "Worker not found" defects until the
      // target script is fully propagated to the same edge that the
      // caller worker hits.
      yield* client.ProxyGreet({ name: "warmup" }).pipe(retryReadyN(10));

      const N = 100;
      const results = yield* Effect.forEach(
        Array.from({ length: N }, (_, i) => i),
        (i) =>
          client
            .ProxyGreet({ name: `peer-${i}` })
            .pipe(Effect.timeout("10 seconds"), retryReadyN(10)),
        { concurrency: 32 },
      );

      expect(results).toHaveLength(N);
      for (let i = 0; i < N; i++) {
        expect(results[i].greeting).toBe(`hello peer-${i}`);
      }
    }).pipe(Effect.scoped, Effect.provide(clientLayer(callerUrl)));
  }).pipe(logLevel),
  { timeout: 60_000 },
);
