import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import Stack from "./fixtures/rpc-do-namespace-do-rpc/stack.ts";
import { WorkerRpcs as RpcWorkerWorkerRpcs } from "./fixtures/rpc-worker-rpc-http/group.ts";
import RpcWorkerStack from "./fixtures/rpc-worker-rpc-http/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

// `Test.rpcClientLayer` guards the transport against edge-generated HTML
// bodies (workers.dev placeholder, error pages) that the RPC protocol would
// otherwise surface as an opaque `RpcClientDefect`; see Test/Http.ts.
const rpcClientLayer = Test.rpcClientLayer;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Cap exponential backoff at 3s so retries stay bounded when CF edge is
// slow (otherwise the geometric blow-up dominates wall time).
const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

// Suffix DO instance ids with a per-process random tag so reruns under
// `NO_DESTROY=1` don't collide with persisted state from earlier runs
// (the DO's `count` lives in `state.storage`).
const runId = Math.random().toString(36).slice(2, 10);
const k = (name: string) => `${name}-${runId}`;

// Retry transient 5xx/network errors from a freshly-deployed worker. The
// worker→DO binding can take a while to propagate to every edge POP, during
// which requests fail with 500 before the DO method ever runs — so retrying
// non-idempotent calls (increment) through this window is safe (the
// 100-concurrent test below relies on the same property).
const retryHttp = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  eff.pipe(Effect.retry({ schedule: readinessSchedule, times: 10 }));

const resetCounter = (url: string, id: string) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    yield* client.post(`${url}/counter/${id}/reset`).pipe(retryHttp);
  });

const readinessRetries = 15;

// The `*DO` RPC handlers forward to the Durable Object via `getByName(...)`.
// On a freshly-deployed worker the DO-namespace binding hasn't propagated to
// every Cloudflare edge yet, so the first calls fail with `Worker not found.`.
// The worker fixture wraps the DO call in `Effect.orDie` / `Stream.orDie`, so
// that error arrives at the client as a DEFECT — and `Effect.retry` does not
// retry defects. Promote defects to failures so the readiness retry can absorb
// the transient binding-propagation error (a genuine bug would simply keep
// failing until the retry budget is exhausted).
const retryReadyN =
  (times: number) =>
  <A, E, R>(eff: Effect.Effect<A, E, R>) =>
    eff.pipe(
      Effect.catchDefect((defect) => Effect.fail(defect)),
      Effect.retry({ schedule: readinessSchedule, times }),
    );

const retryReady = retryReadyN(readinessRetries);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// Gate the deploy on the worker→DO binding having propagated to the edge:
// hit both the unary and streaming `*DO` paths once, retrying through the
// transient `Worker not found.` window, so individual tests can call the
// `*DO` RPCs directly without each having to re-implement the readiness retry.
const rpcWorkerStack = beforeAll(
  deploy(RpcWorkerStack).pipe(
    Effect.tap((outputs) =>
      Effect.gen(function* () {
        const c = yield* RpcClient.make(RpcWorkerWorkerRpcs);
        yield* c.PingDO({ message: "warmup" }).pipe(retryReady);
        yield* c.CountDO({ upto: 1 }).pipe(Stream.runCollect, retryReady);
      }).pipe(Effect.scoped, Effect.provide(rpcClientLayer(outputs.url))),
    ),
    // just give it some extra time to propagate
    Effect.tap(Effect.sleep("5 seconds")),
  ),
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(RpcWorkerStack));

test(
  "RpcDurableObject: Increment / Get round-trip via Worker",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const alpha = k("alpha");
    yield* resetCounter(url, alpha);
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const incRes = yield* client
      .post(`${url}/counter/${alpha}/increment`)
      .pipe(retryHttp);
    expect(incRes.status).toBe(200);
    const inc = (yield* incRes.json) as { count: number };
    expect(inc.count).toBe(1);

    yield* client.post(`${url}/counter/${alpha}/increment`).pipe(retryHttp);
    yield* client.post(`${url}/counter/${alpha}/increment`).pipe(retryHttp);

    const getRes = yield* client.get(`${url}/counter/${alpha}`).pipe(retryHttp);
    expect(getRes.status).toBe(200);
    const got = (yield* getRes.json) as { count: number };
    expect(got.count).toBe(3);
  }).pipe(logLevel),
  { timeout: 30_000 },
);

test(
  "RpcDurableObject: separate getByName(id) instances are isolated",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const betaId = k("beta");
    const gammaId = k("gamma");
    yield* resetCounter(url, betaId);
    yield* resetCounter(url, gammaId);
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    yield* client.post(`${url}/counter/${betaId}/increment`).pipe(retryHttp);

    const beta = (yield* (yield* client
      .get(`${url}/counter/${betaId}`)
      .pipe(retryHttp)).json) as {
      count: number;
    };
    const gamma = (yield* (yield* client
      .get(`${url}/counter/${gammaId}`)
      .pipe(retryHttp)).json) as {
      count: number;
    };
    expect(beta.count).toBe(1);
    expect(gamma.count).toBe(0);
  }).pipe(logLevel),
  { timeout: 30_000 },
);

test(
  "RpcDurableObject: streaming RPC via getByName(id).CountUpTo",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const delta = k("delta");
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    // The stream route commits a 200 before the DO stream produces data, so
    // a transient `Worker not found.` during binding propagation dies AFTER
    // the headers are sent and surfaces as a truncated/empty 200 body —
    // invisible to status-based retries. `CountUpTo` is a pure stream, so
    // retry on content until all four lines arrive.
    const lines = yield* client
      .get(`${url}/counter/${delta}/stream?upto=4`)
      .pipe(
        Effect.flatMap((res) => res.text),
        Effect.flatMap((body) => {
          const lines = body.split("\n").filter((l) => l.length > 0);
          return lines.length === 4
            ? Effect.succeed(lines)
            : Effect.fail(
                new Error(`truncated stream body: ${JSON.stringify(lines)}`),
              );
        }),
        retryHttp,
      );
    expect(lines).toEqual(["1", "2", "3", "4"]);
  }).pipe(logLevel),
  { timeout: 30_000 },
);

test(
  "RpcWorker + RpcDurableObject: Worker proxies *DO RPCs through the typed namespace",
  Effect.gen(function* () {
    const { url } = yield* rpcWorkerStack;

    yield* Effect.gen(function* () {
      const c = yield* RpcClient.make(RpcWorkerWorkerRpcs);
      const ping = yield* c.Ping({ message: "hi" }).pipe(retryReady);
      expect(ping.echo).toBe("hi");

      const pingDO = yield* c.PingDO({ message: "via DO" }).pipe(retryReady);
      expect(pingDO.echo).toBe("via DO");
    }).pipe(Effect.scoped, Effect.provide(rpcClientLayer(url)));
  }).pipe(logLevel),
  { timeout: 30_000 },
);

test(
  "RpcDurableObject: 100 concurrent Increment calls do not hang",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const concurrent = k("concurrent");
    yield* resetCounter(url, concurrent);
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    yield* client
      .post(`${url}/counter/${concurrent}/increment`)
      .pipe(retryHttp);

    const N = 100;
    const results = yield* Effect.forEach(
      Array.from({ length: N }, (_, i) => i),
      () =>
        client.post(`${url}/counter/${concurrent}/increment`).pipe(
          Effect.flatMap((res) => res.json),
          Effect.timeout("10 seconds"),
          // Under full-suite load the account churns through worker
          // deploys/deletes and workers.dev routing intermittently 404s an
          // existing worker for several seconds; `times: 3` (~3.5s) is not
          // enough to ride out a blip when 100 requests each get 4 chances.
          // Retry only HTTP failures (a 404/5xx never reached the DO, so the
          // increment can't double-count); a timeout is ambiguous and stays
          // un-retried so the final-count assertion holds.
          Effect.retry({
            while: (e) => e._tag === "HttpClientError",
            schedule: readinessSchedule,
            times: 10,
          }),
        ),
      { concurrency: 32 },
    );

    expect(results).toHaveLength(N);
    const finalRes = yield* client
      .get(`${url}/counter/${concurrent}`)
      .pipe(retryHttp);
    const final = (yield* finalRes.json) as { count: number };
    expect(final.count).toBe(N + 1);
  }).pipe(logLevel),
  { timeout: 30_000 },
);

test(
  "RpcWorker + RpcDurableObject: 100 concurrent unary RPCs do not hang",
  Effect.gen(function* () {
    const { url } = yield* rpcWorkerStack;

    yield* Effect.gen(function* () {
      const c = yield* RpcClient.make(RpcWorkerWorkerRpcs);

      const N = 100;
      const results = yield* Effect.forEach(
        Array.from({ length: N }, (_, i) => i),
        (i) =>
          c.Ping({ message: `m-${i}` }).pipe(
            Effect.timeout("10 seconds"),
            // A cold PoP mid-propagation returns Cloudflare's HTML error
            // page, which is not valid ndjson and surfaces as a retryable
            // `RpcClientError` (`RpcClientDefect: Error decoding HTTP
            // response`); `times: 3` (~6s) is not enough to ride out a
            // multi-second blip across 100 requests. Ping is idempotent.
            retryReadyN(8),
          ),
        { concurrency: 32 },
      );

      expect(results).toHaveLength(N);
      for (let i = 0; i < N; i++) {
        expect(results[i].echo).toBe(`m-${i}`);
      }
    }).pipe(Effect.scoped, Effect.provide(rpcClientLayer(url)));
  }).pipe(logLevel),
  { timeout: 60_000 },
);

test(
  "RpcWorker + RpcDurableObject: 100 concurrent *DO unary RPCs do not hang",
  Effect.gen(function* () {
    const { url } = yield* rpcWorkerStack;

    yield* Effect.gen(function* () {
      const c = yield* RpcClient.make(RpcWorkerWorkerRpcs);

      const N = 100;
      const results = yield* Effect.forEach(
        Array.from({ length: N }, (_, i) => i),
        (i) =>
          c
            .PingDO({ message: `m-${i}` })
            .pipe(Effect.timeout("10 seconds"), retryReadyN(5)),
        { concurrency: 16 },
      );

      expect(results).toHaveLength(N);
      for (let i = 0; i < N; i++) {
        expect(results[i].echo).toBe(`m-${i}`);
      }
    }).pipe(Effect.scoped, Effect.provide(rpcClientLayer(url)));
  }).pipe(logLevel),
  { timeout: 30_000 },
);

test(
  "RpcWorker + RpcDurableObject: 100 concurrent streaming *DO RPCs do not hang",
  Effect.gen(function* () {
    const { url } = yield* rpcWorkerStack;

    yield* Effect.gen(function* () {
      const c = yield* RpcClient.make(RpcWorkerWorkerRpcs);

      const N = 100;
      const results = yield* Effect.forEach(
        Array.from({ length: N }, (_, i) => i),
        (i) =>
          c
            .CountDO({ upto: 3 + (i % 3) })
            .pipe(
              Stream.runCollect,
              Effect.timeout("10 seconds"),
              retryReadyN(5),
            ),
        { concurrency: 16 },
      );

      expect(results).toHaveLength(N);
      for (let i = 0; i < N; i++) {
        expect(results[i]).toEqual(
          Array.from({ length: 3 + (i % 3) }, (_, n) => n + 1),
        );
      }
    }).pipe(Effect.scoped, Effect.provide(rpcClientLayer(url)));
  }).pipe(logLevel),
  { timeout: 30_000 },
);
