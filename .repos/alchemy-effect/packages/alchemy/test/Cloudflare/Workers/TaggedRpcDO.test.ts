import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { poll } from "@/Util/poll.ts";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
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

// Under a full-suite run the edge propagates fresh `*.workers.dev` URLs much
// more slowly than in isolation — give each test ample room.
const testTimeout = 120_000;
const requestTimeout = "5 seconds";
// Fresh `*.workers.dev` URLs propagate through the edge over a few seconds —
// the first requests routinely return 404 / 500 before the script is
// resolvable. `Effect.retry` only fires on Effect failures, not on HTTP
// status codes, so we explicitly `Effect.fail` non-2xx responses to force a
// retry through `readinessRetry`.
// Cap exponential backoff at 3s so cold-start retries stay bounded when
// CF edge propagation is slow. Fresh `*.workers.dev` subdomains routinely
// take over a minute to stop serving the placeholder page, so the budget
// must comfortably exceed that (~2 minutes here).
const readinessRetry = {
  schedule: Schedule.min([
    Schedule.exponential("500 millis"),
    Schedule.spaced("3 seconds"),
  ]),
  times: 40,
} as const;

const requestUntilReady = (
  effect: Effect.Effect<HttpClientResponse, unknown, never>,
) =>
  effect.pipe(
    Effect.timeout(requestTimeout),
    Effect.flatMap(
      Effect.fn(function* (res) {
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

// A response whose body is Cloudflare's "script not found" / workers.dev
// placeholder page means the request never reached the Worker script at all —
// no write could have committed, so retrying is safe even for non-idempotent
// increments. Anything else non-2xx is ambiguous (the write may have
// committed) and must fail the test instead of retrying.
class EdgeNotReady extends Data.TaggedError("EdgeNotReady")<{
  status: number;
}> {}

const looksLikeEdgePlaceholder = (body: string) =>
  body.includes("There is nothing here yet") ||
  body.includes("Script not found") ||
  body.includes("cf-error-code");

const postIncrementOnce = (
  effect: Effect.Effect<HttpClientResponse, unknown, never>,
) =>
  effect.pipe(
    Effect.timeout(requestTimeout),
    Effect.flatMap(
      Effect.fn(function* (res) {
        if (res.status >= 200 && res.status < 300) {
          return res;
        }
        const body = yield* res.text;
        return looksLikeEdgePlaceholder(body)
          ? yield* Effect.fail(new EdgeNotReady({ status: res.status }))
          : yield* Effect.die(
              new Error(`increment failed: ${res.status} ${body}`),
            );
      }),
    ),
    Effect.retry({
      while: (e) => e instanceof EdgeNotReady,
      schedule: readinessRetry.schedule,
      times: readinessRetry.times,
    }),
  );

// The RPC edge has the same cold-start hazard as the raw HTTP edge: a request
// landing on a PoP that hasn't resolved the script yet gets Cloudflare's
// placeholder HTML, which is not valid ndjson, so the client surfaces an
// `RpcClientError` whose `reason` is an `RpcClientDefect` ("Error decoding HTTP
// response"). A decode defect proves the response never came from the Worker
// handler — so the RPC never executed and no write committed. That makes it
// the one RPC failure safe to retry even for a non-idempotent increment (the
// RPC analogue of `postIncrementOnce`/`EdgeNotReady`). Any other failure
// (transport error, a typed handler error) is ambiguous and is NOT retried.
const isEdgeNotReadyRpc = (e: unknown): boolean =>
  e instanceof RpcClientError && e.reason._tag === "RpcClientDefect";

const rpcUntilReady = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.retry(effect, {
    while: isEdgeNotReadyRpc,
    schedule: readinessRetry.schedule,
    times: readinessRetry.times,
  });

// Each test addresses its own DO instance via a unique counter key so the
// tests are safe to run in parallel. WorkerB / WorkerC fixtures read
// the `x-counter-key` header; WorkerA's RPC takes `key` directly in
// every payload.
const withCounterKey = (key: string) =>
  HttpClient.mapRequest(HttpClientRequest.setHeader("x-counter-key", key));

// WorkerA's typed RPC transport is `Test.rpcClientLayer` (see Test/Http.ts).
// Its transport-level retry fires only on non-ndjson responses — edge pages
// that prove the handler never ran (see `isEdgeNotReadyRpc` above) — so it
// is safe for the non-idempotent increment bodies below.
const rpcClientLayer = Test.rpcClientLayer;

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
//
// Cold-start hazards on this path can also surface as DEFECTS, not failures:
// while the deploy propagates, the Cloudflare runtime throws
// "Worker not found." (service/DO binding not yet resolvable) or
// "Handler does not export a fetch() function." (the pre-created stub
// script, uploaded before the real bundle, is still live on the PoP).
// The RPC server serializes those as defects and the client re-raises them
// as defects, which `Effect.retry` will NOT retry. Since `reset` is
// idempotent, demote defects to failures so the readiness retry rides
// them out like any other cold-start blip.
const resetA = (url: string, key: string) =>
  withRpcA(
    url,
    Effect.gen(function* () {
      const c = yield* RpcClient.make(CounterRpcs);
      yield* c.reset({ key });
    }),
  ).pipe(
    Effect.catchDefect((defect) => Effect.fail(defect)),
    Effect.retry(readinessRetry),
  );

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
  // deploy + the ~2-minute warmup retry budget can exceed the default
  // 120s hook timeout when workers.dev propagation is slow
  { timeout: 300_000 },
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "RpcWorker WorkerA exposes the same RPC surface as the underlying DO",
  Effect.gen(function* () {
    const { urlA } = yield* stack;
    const key = "rpc-worker-a";

    yield* resetA(urlA, key);

    yield* withRpcA(
      urlA,
      Effect.gen(function* () {
        const c = yield* RpcClient.make(CounterRpcs);
        const first = yield* rpcUntilReady(c.incrementD1({ key }));
        const second = yield* rpcUntilReady(c.incrementD1({ key }));
        const get = yield* rpcUntilReady(c.getD1({ key }));
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
        const inc1 = yield* rpcUntilReady(c.incrementD1({ key }));
        expect(inc1.value).toBe(1);
        const inc2 = yield* rpcUntilReady(c.incrementD1({ key }));
        expect(inc2.value).toBe(2);
      }),
    );

    // D1 cross-script reads are eventually consistent: the GET is
    // idempotent, so retry on *any* failure until WorkerB's replica
    // catches up to the committed writes. A status retry alone wouldn't
    // cover a 200 that still reports the stale value, so fail on a
    // value mismatch too and let the same retry absorb both that and
    // transient HTTP errors.
    const httpClient = (yield* HttpClient.HttpClient).pipe(withCounterKey(key));
    const value = yield* httpClient.get(`${urlB}/d1`).pipe(
      Effect.timeout(requestTimeout),
      Effect.flatMap((res) => res.json),
      Effect.map((body) => (body as { value: number }).value),
      Effect.filterOrFail((value) => value === 2),
      Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
    );
    expect(value).toBe(2);
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
        const inc1 = yield* rpcUntilReady(c.incrementDO({ key }));
        expect(inc1.value).toBe(1);
        const inc2 = yield* rpcUntilReady(c.incrementDO({ key }));
        expect(inc2.value).toBe(2);
      }),
    );

    const httpClient = (yield* HttpClient.HttpClient).pipe(withCounterKey(key));
    const fromB = yield* requestUntilReady(httpClient.get(`${urlB}/do`));
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
    // These increments are non-idempotent: blind retries on a request whose
    // write committed but whose response failed would over-count. But edge
    // propagation is not monotonic — a request can still land on a PoP that
    // hasn't resolved the script yet (placeholder page), in which case no
    // write happened and a retry is safe. `postIncrementOnce` retries exactly
    // that case and dies on anything else ambiguous.
    yield* postIncrementOnce(httpClient.post(`${urlB}/d1/increment`));
    yield* postIncrementOnce(httpClient.post(`${urlB}/d1/increment`));
    yield* postIncrementOnce(httpClient.post(`${urlB}/do/increment`));

    // The writes above (WorkerB → WorkerA's cross-script DO) are
    // eventually consistent when read back through WorkerA's RPC:
    // D1 in particular can lag a beat before the second increment
    // is visible from the reading replica. getD1/getDO are
    // idempotent, so poll the read pair until both counters settle
    // rather than reading once and flaking on "expected 1 to be 2".
    //
    // Build a FRESH RPC client per poll iteration (withRpcA provides the
    // protocol layer + scope) rather than sharing one client across every
    // retry: the ndjson HTTP transport can't reconstruct a request whose
    // body was already consumed on a previous swing ("Cannot reconstruct a
    // Request with a used body"), so each iteration gets its own transport.
    const { d1, dox } = yield* poll({
      description: "WorkerB writes visible from WorkerA (d1=2, do=1)",
      effect: withRpcA(
        urlA,
        Effect.gen(function* () {
          const c = yield* RpcClient.make(CounterRpcs);
          return yield* Effect.all({
            d1: rpcUntilReady(c.getD1({ key })),
            dox: rpcUntilReady(c.getDO({ key })),
          });
        }),
      ),
      predicate: ({ d1, dox }) => d1.value === 2 && dox.value === 1,
      schedule: Schedule.max([
        Schedule.spaced("2 seconds"),
        Schedule.recurs(30),
      ]),
    });
    expect(d1.value).toBe(2);
    expect(dox.value).toBe(1);
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
        yield* rpcUntilReady(c.incrementDO({ key }));
      }),
    );

    const httpClient = (yield* HttpClient.HttpClient).pipe(withCounterKey(key));
    // Non-idempotent increment — only the safe placeholder case is retried.
    yield* postIncrementOnce(httpClient.post(`${urlB}/do/increment`));

    // WorkerA sees value 2 (its own + WorkerB's cross-script).
    yield* withRpcA(
      urlA,
      Effect.gen(function* () {
        const c = yield* RpcClient.make(CounterRpcs);
        const fromA = yield* rpcUntilReady(c.getDO({ key }));
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
    yield* postIncrementOnce(httpClient.post(`${urlC}/do/increment`));
    yield* postIncrementOnce(httpClient.post(`${urlC}/do/increment`));
    yield* postIncrementOnce(httpClient.post(`${urlC}/do/increment`));

    const cAfter = yield* httpClient
      .get(`${urlC}/do`)
      .pipe(Effect.timeout(requestTimeout));
    expect((yield* cAfter.json) as { value: number }).toEqual({ value: 3 });

    yield* withRpcA(
      urlA,
      Effect.gen(function* () {
        const c = yield* RpcClient.make(CounterRpcs);
        const aAfter = yield* rpcUntilReady(c.getDO({ key }));
        expect(aAfter.value).toBe(2);
      }),
    );
  }).pipe(logLevel),
  { timeout: testTimeout },
);
