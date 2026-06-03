import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import { CounterRpcs } from "./fixtures/tagged-rpc-do/group.ts";
import Stack from "./fixtures/tagged-rpc-do/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const testTimeout = 30_000;
const requestTimeout = "5 seconds";
// Fresh `*.workers.dev` URLs propagate through the edge over a few seconds —
// the first requests routinely return 404 / 500 before the script is
// resolvable. `Effect.retry` only fires on Effect failures, not on HTTP
// status codes, so we explicitly `Effect.fail` non-2xx responses to force a
// retry through `readinessRetry`.
// Cap exponential backoff at 3s so cold-start retries stay bounded when
// CF edge propagation is slow.
const readinessRetry = {
  schedule: Schedule.exponential("500 millis").pipe(
    Schedule.either(Schedule.spaced("3 seconds")),
  ),
  times: 15,
} as const;

const requestUntilReady = (
  effect: Effect.Effect<HttpClientResponse, unknown, never>,
) =>
  effect.pipe(
    Effect.timeout(requestTimeout),
    Effect.flatMap(
      Effect.fnUntraced(function* (res) {
        return res.status >= 200 && res.status < 300
          ? res
          : yield* Effect.fail(
              new Error(`Worker not ready: ${res.status} ${yield* res.text}`),
            );
      }),
    ),
    Effect.tapError(Effect.logError),
    Effect.retry(readinessRetry),
  );

// Each test addresses its own DO instance via a unique counter key so the
// tests are safe to run in parallel. WorkerB / WorkerC fixtures read
// the `x-counter-key` header; WorkerA's RPC takes `key` directly in
// every payload.
const withCounterKey = (key: string) =>
  HttpClient.mapRequest(HttpClientRequest.setHeader("x-counter-key", key));

// Build a typed `RpcClient<CounterRpcs>` against WorkerA's URL.
// Every call rides through the same JSON edge as the worker.dev URL,
// so we share the readiness retry below at the test layer.
const rpcClientLayer = (url: string) =>
  RpcClient.layerProtocolHttp({ url }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      Layer.succeed(RpcSerialization.RpcSerialization, RpcSerialization.ndjson),
    ),
  );

// Drive a typed `RpcClient<CounterRpcs>` body against WorkerA's URL.
// Each call gets its own scope (so the client is freed promptly).
//
// NOTE: `withRpcA` deliberately does NOT retry the body. The bodies below
// perform non-idempotent D1/DO increments, and a body-level retry would
// re-apply a mutation whose server-side write already committed but whose
// response failed transiently (the classic "expected 2 to be 1" flake).
// Readiness is instead handled idempotently: each test runs a retried
// `resetA`/`resetHttp` first (which also warms the edge), and the `beforeAll`
// gate below settles propagation before any test runs.
type RpcRequirements =
  | RpcClient.Protocol
  | RpcSerialization.RpcSerialization
  | Scope.Scope;
const withRpcA = <A, E, R>(url: string, body: Effect.Effect<A, E, R>) =>
  body.pipe(
    Effect.tapError((e) => Effect.logError("withRpcA error", e)),
    Effect.scoped,
    Effect.provide(rpcClientLayer(url)),
  ) as Effect.Effect<A, E, Exclude<R, RpcRequirements>>;

const resetHttp = (url: string, key: string) =>
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(withCounterKey(key));
    yield* requestUntilReady(client.post(`${url}/reset`));
  });

// `reset` is idempotent, so it's safe to retry — this doubles as the
// per-test readiness gate for WorkerA's RPC edge.
const resetA = (url: string, key: string) =>
  withRpcA(
    url,
    Effect.gen(function* () {
      const c = yield* RpcClient.make(CounterRpcs);
      yield* c.reset({ key });
    }),
  ).pipe(Effect.retry(readinessRetry));

// Gate the deploy on all three workers' edges being resolvable (via the
// idempotent reset path), then let propagation settle, so the non-retried
// increment bodies below don't race cold-start.
const stack = beforeAll(
  deploy(Stack).pipe(
    Effect.tap(({ urlA, urlB, urlC }) =>
      Effect.all(
        [
          resetA(urlA, "warmup"),
          resetHttp(urlB, "warmup"),
          resetHttp(urlC, "warmup"),
        ],
        { concurrency: "unbounded" },
      ),
    ),
    // just give it some extra time to propagate
    Effect.tap(Effect.sleep("5 seconds")),
  ),
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "RpcWorker WorkerA exposes the same RPC surface as the underlying DO",
  Effect.gen(function* () {
    const { urlA, urlB, urlC } = yield* stack;
    console.log("URLS:", { urlA, urlB, urlC });
    const key = "rpc-worker-a";

    yield* resetA(urlA, key);

    yield* withRpcA(
      urlA,
      Effect.gen(function* () {
        const c = yield* RpcClient.make(CounterRpcs);
        const first = yield* c.incrementD1({ key });
        console.log("withRpcA", first);
        const second = yield* c.incrementD1({ key });
        const get = yield* c.getD1({ key });
        expect(first.value).toBe(1);
        expect(second.value).toBe(2);
        expect(get.value).toBe(2);
      }),
    );
  }).pipe(logLevel),
  { timeout: testTimeout },
);

test(
  "D1 counter writes via WorkerA's RPC are visible from WorkerB (cross-script DO)",
  Effect.gen(function* () {
    const { urlA, urlB } = yield* stack;
    const key = "d1-cross";

    yield* resetA(urlA, key);
    yield* resetHttp(urlB, key);

    yield* withRpcA(
      urlA,
      Effect.gen(function* () {
        const c = yield* RpcClient.make(CounterRpcs);
        const inc1 = yield* c.incrementD1({ key });
        expect(inc1.value).toBe(1);
        const inc2 = yield* c.incrementD1({ key });
        expect(inc2.value).toBe(2);
      }),
    );

    const httpClient = (yield* HttpClient.HttpClient).pipe(withCounterKey(key));
    const fromB = yield* httpClient
      .get(`${urlB}/d1`)
      .pipe(Effect.timeout(requestTimeout), Effect.retry(readinessRetry));
    expect(fromB.status).toBe(200);
    expect((yield* fromB.json) as { value: number }).toEqual({ value: 2 });
  }).pipe(logLevel),
  { timeout: testTimeout },
);

test(
  "DO storage counter writes via WorkerA's RPC are visible from WorkerB (cross-script DO)",
  Effect.gen(function* () {
    const { urlA, urlB } = yield* stack;
    const key = "do-cross";

    yield* resetA(urlA, key);
    yield* resetHttp(urlB, key);

    yield* withRpcA(
      urlA,
      Effect.gen(function* () {
        const c = yield* RpcClient.make(CounterRpcs);
        const inc1 = yield* c.incrementDO({ key });
        expect(inc1.value).toBe(1);
        const inc2 = yield* c.incrementDO({ key });
        expect(inc2.value).toBe(2);
      }),
    );

    const httpClient = (yield* HttpClient.HttpClient).pipe(withCounterKey(key));
    const fromB = yield* httpClient
      .get(`${urlB}/do`)
      .pipe(Effect.timeout(requestTimeout), Effect.retry(readinessRetry));
    expect(fromB.status).toBe(200);
    expect((yield* fromB.json) as { value: number }).toEqual({ value: 2 });
  }).pipe(logLevel),
  { timeout: testTimeout },
);

test(
  "Writes from WorkerB are visible from WorkerA's RPC (bidirectional cross-script DO)",
  Effect.gen(function* () {
    const { urlA, urlB } = yield* stack;
    const key = "bidirectional";

    yield* resetA(urlA, key);
    yield* resetHttp(urlB, key);

    const httpClient = (yield* HttpClient.HttpClient).pipe(withCounterKey(key));
    // These increments are non-idempotent: retrying a request whose write
    // committed but whose response failed would over-count. The `resetHttp`
    // above (retried) has already warmed WorkerB's edge, so run them once.
    yield* httpClient
      .post(`${urlB}/d1/increment`)
      .pipe(Effect.timeout(requestTimeout));
    yield* httpClient
      .post(`${urlB}/d1/increment`)
      .pipe(Effect.timeout(requestTimeout));
    yield* httpClient
      .post(`${urlB}/do/increment`)
      .pipe(Effect.timeout(requestTimeout));

    yield* withRpcA(
      urlA,
      Effect.gen(function* () {
        const c = yield* RpcClient.make(CounterRpcs);
        const d1 = yield* c.getD1({ key });
        const dox = yield* c.getDO({ key });
        expect(d1.value).toBe(2);
        expect(dox.value).toBe(1);
      }),
    );
  }).pipe(logLevel),
  { timeout: testTimeout },
);

test(
  "WorkerC hosts its own isolated Counter (writes from A/B are not visible from C)",
  Effect.gen(function* () {
    const { urlA, urlB, urlC } = yield* stack;
    const key = "isolation";

    yield* resetA(urlA, key);
    yield* resetHttp(urlB, key);
    yield* resetHttp(urlC, key);

    // Increment via WorkerA (RPC) and WorkerB (HTTP → cross-script DO);
    // both route to WorkerA's hosted Counter.
    yield* withRpcA(
      urlA,
      Effect.gen(function* () {
        const c = yield* RpcClient.make(CounterRpcs);
        yield* c.incrementDO({ key });
      }),
    );

    const httpClient = (yield* HttpClient.HttpClient).pipe(withCounterKey(key));
    // Non-idempotent increment — run once (resetHttp above warmed the edge).
    yield* httpClient
      .post(`${urlB}/do/increment`)
      .pipe(Effect.timeout(requestTimeout));

    // WorkerA sees value 2 (its own + WorkerB's cross-script).
    yield* withRpcA(
      urlA,
      Effect.gen(function* () {
        const c = yield* RpcClient.make(CounterRpcs);
        const fromA = yield* c.getDO({ key });
        expect(fromA.value).toBe(2);
      }),
    );

    // WorkerC hosts its own Counter namespace via `Counter.from(WorkerC)`,
    // so its DO instance has never been written to.
    const fromC = yield* httpClient
      .get(`${urlC}/do`)
      .pipe(Effect.timeout(requestTimeout), Effect.retry(readinessRetry));
    expect((yield* fromC.json) as { value: number }).toEqual({ value: 0 });

    // Writes through WorkerC do not leak back to WorkerA either.
    yield* httpClient
      .post(`${urlC}/do/increment`)
      .pipe(Effect.timeout(requestTimeout));
    yield* httpClient
      .post(`${urlC}/do/increment`)
      .pipe(Effect.timeout(requestTimeout));
    yield* httpClient
      .post(`${urlC}/do/increment`)
      .pipe(Effect.timeout(requestTimeout));

    const cAfter = yield* httpClient
      .get(`${urlC}/do`)
      .pipe(Effect.timeout(requestTimeout));
    expect((yield* cAfter.json) as { value: number }).toEqual({ value: 3 });

    yield* withRpcA(
      urlA,
      Effect.gen(function* () {
        const c = yield* RpcClient.make(CounterRpcs);
        const aAfter = yield* c.getDO({ key });
        expect(aAfter.value).toBe(2);
      }),
    );
  }).pipe(logLevel),
  { timeout: testTimeout },
);
