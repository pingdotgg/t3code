import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { TaskApi } from "./fixtures/http-api/api.ts";
import Stack from "./fixtures/http-api/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const testTimeout = 60_000;
const burstTimeout = 90_000;
const requestTimeout = "5 seconds";
// A fresh Cloudflare deploy is eventually consistent and NOT atomic across
// edge PoPs: the script, the workers.dev route, and each binding (R2 / D1 /
// DO namespace + migration) propagate independently. Until they converge,
// requests landing on a cold PoP return a `404` (route not resolvable) or a
// `500` (script up, binding not ready). New DO namespaces / D1 databases are
// the slowest, so the readiness window comfortably exceeds 15s in the tail.
// Retry on a steady 1.5s cadence for ~30s so every first-touch request rides
// out the convergence window regardless of which PoP it hits.
const readinessRetry = {
  schedule: Schedule.spaced("1500 millis"),
  times: 20,
} as const;

const makeClient = (url: string) =>
  HttpApiClient.make(TaskApi, { baseUrl: url });

// The raw `HttpClient` (used for transport-level CORS checks) does not fail on
// a non-2xx status, so `Effect.retry` won't fire on the freshly-deployed edge
// 404/500 window. Explicitly `Effect.fail` non-2xx responses to force the
// retry (unlike the typed `HttpApiClient`, which already fails on them).
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
    Effect.retry(readinessRetry),
  );

// Gate the deploy on the worker having propagated to the edge: hit both the
// R2-backed (`createTask`) and DO-backed (`createTaskDO`) paths once, retrying
// through the freshly-deployed 404 window, then give it extra time to settle
// across edge PoPs. Individual tests can then call the API directly without
// each re-implementing a per-request readiness retry.
const stack = beforeAll(
  deploy(Stack).pipe(
    Effect.tap(({ url }) =>
      Effect.gen(function* () {
        const client = yield* makeClient(url);
        yield* client.Tasks.createTask({ payload: { title: "warmup" } }).pipe(
          Effect.timeout(requestTimeout),
          Effect.retry(readinessRetry),
        );
        yield* client.Tasks.createTaskDO({ payload: { title: "warmup" } }).pipe(
          Effect.timeout(requestTimeout),
          Effect.retry(readinessRetry),
        );
      }),
    ),
    // just give it some extra time to propagate
    Effect.tap(Effect.sleep("5 seconds")),
  ),
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "deployed http-api worker handles createTask + getTask via typed HttpApiClient",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeTypeOf("string");
    const client = yield* makeClient(url);

    const created = yield* client.Tasks.createTask({
      payload: { title: "Write docs" },
    }).pipe(Effect.timeout(requestTimeout), Effect.retry(readinessRetry));
    expect(created.title).toBe("Write docs");
    expect(created.completed).toBe(false);
    expect(created.id).toBeTypeOf("string");

    const fetched = yield* client.Tasks.getTask({
      params: { id: created.id },
    }).pipe(Effect.timeout(requestTimeout), Effect.retry(readinessRetry));
    expect(fetched.id).toBe(created.id);
    expect(fetched.title).toBe("Write docs");

    // No retry here: `TaskNotFound` is the expected domain result, not a
    // transient readiness failure — retrying would just re-run the 404.
    const missing = yield* client.Tasks.getTask({
      params: { id: "does-not-exist" },
    }).pipe(Effect.flip);
    expect(missing._tag).toBe("TaskNotFound");
    if (missing._tag === "TaskNotFound") {
      expect(missing.id).toBe("does-not-exist");
    }
  }).pipe(logLevel),
  { timeout: testTimeout },
);

test(
  "cors middleware adds Access-Control-Allow-Origin header on preflight",
  Effect.gen(function* () {
    const { url } = yield* stack;
    // CORS preflight (OPTIONS) is transport-level and not part of the typed
    // HttpApi surface, so this single check uses the raw HttpClient.
    const client = yield* HttpClient.HttpClient;

    const res = yield* requestUntilReady(
      client.execute(
        HttpClientRequest.make("OPTIONS")(url).pipe(
          HttpClientRequest.setHeaders({
            Origin: "https://example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
          }),
        ),
      ),
    );
    expect(res.headers["access-control-allow-origin"]).toBeDefined();
  }).pipe(logLevel),
  { timeout: testTimeout },
);

test(
  "cors middleware adds Access-Control-Allow-Origin header on actual requests",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const res = yield* requestUntilReady(
      client.execute(
        HttpClientRequest.post(`${url}/`).pipe(
          HttpClientRequest.setHeaders({ Origin: "https://example.com" }),
          HttpClientRequest.bodyJsonUnsafe({ title: "cors-check" }),
        ),
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeDefined();
  }).pipe(logLevel),
  { timeout: testTimeout },
);

test(
  "concurrent createTask survives scope-lifecycle pressure",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* makeClient(url);

    const N = 200;
    const results = yield* Effect.forEach(
      Array.from({ length: N }, (_, i) => i),
      (i) =>
        Effect.gen(function* () {
          const created = yield* client.Tasks.createTask({
            payload: { title: `task-${i}` },
          }).pipe(Effect.timeout(requestTimeout), Effect.retry(readinessRetry));
          if (created.title !== `task-${i}`) {
            return yield* Effect.fail(
              new Error(`create ${i} title mismatch: ${created.title}`),
            );
          }
          return created.id;
        }),
      { concurrency: 64 },
    );

    expect(results).toHaveLength(N);
    expect(new Set(results).size).toBe(N);
  }).pipe(logLevel),
  { timeout: burstTimeout },
);

test(
  "createTaskDO + getTaskDO round-trip 100x in parallel through the DO HttpApi",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* makeClient(url);

    const N = 100;
    yield* Effect.forEach(
      Array.from({ length: N }, (_, i) => i),
      (i) =>
        Effect.gen(function* () {
          const title = `do-task-${i}`;
          const created = yield* client.Tasks.createTaskDO({
            payload: { title },
          }).pipe(Effect.timeout(requestTimeout), Effect.retry(readinessRetry));
          expect(created.title).toBe(title);
          expect(created.completed).toBe(false);
          expect(created.id).toBeTypeOf("string");

          const fetched = yield* client.Tasks.getTaskDO({
            params: { id: created.id },
          }).pipe(Effect.timeout(requestTimeout), Effect.retry(readinessRetry));
          expect(fetched.id).toBe(created.id);
          expect(fetched.title).toBe(title);
        }),
      { concurrency: 32 },
    );
  }).pipe(logLevel),
  { timeout: burstTimeout },
);
