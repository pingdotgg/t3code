import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";
import Stack from "./fixtures/tagged-do/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const testTimeout = 20_000;
const requestTimeout = "5 seconds";
// Fresh `*.workers.dev` URLs propagate through the edge over a few seconds —
// the first requests routinely return 404 / 500 before the script is
// resolvable. `Effect.retry` only fires on Effect failures, not on HTTP
// status codes, so we explicitly `Effect.fail` non-2xx responses to force a
// retry through `readinessRetry`.
const readinessRetry = {
  schedule: Schedule.exponential("500 millis"),
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
    Effect.retry(readinessRetry),
  );

// Each test addresses its own DO instance via a unique counter key so the
// tests are safe to run in parallel. The fixture Workers read this header
// and forward it as the argument to `counter.getByName(key)`.
const withCounterKey = (key: string) =>
  HttpClient.mapRequest(HttpClientRequest.setHeader("x-counter-key", key));

const reset = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    yield* requestUntilReady(client.post(`${url}/reset`));
  });

test(
  "D1 counter writes from WorkerA are visible from WorkerB (cross-script DO)",
  Effect.gen(function* () {
    const { urlA, urlB } = yield* stack;
    const client = (yield* HttpClient.HttpClient).pipe(
      withCounterKey("d1-cross"),
    );

    yield* reset(urlA).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );
    yield* reset(urlB).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );

    const first = yield* requestUntilReady(client.post(`${urlA}/d1/increment`));
    expect(first.status).toBe(200);
    expect((yield* first.json) as { value: number }).toEqual({ value: 1 });

    const second = yield* requestUntilReady(
      client.post(`${urlA}/d1/increment`),
    );
    expect((yield* second.json) as { value: number }).toEqual({ value: 2 });

    const fromB = yield* requestUntilReady(client.get(`${urlB}/d1`));
    expect(fromB.status).toBe(200);
    expect((yield* fromB.json) as { value: number }).toEqual({ value: 2 });
  }).pipe(logLevel),
  { timeout: testTimeout },
);

test(
  "DO storage counter writes from WorkerA are visible from WorkerB (cross-script DO)",
  Effect.gen(function* () {
    const { urlA, urlB } = yield* stack;
    const client = (yield* HttpClient.HttpClient).pipe(
      withCounterKey("do-cross"),
    );

    yield* reset(urlA).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );
    yield* reset(urlB).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );

    const first = yield* requestUntilReady(client.post(`${urlA}/do/increment`));
    expect(first.status).toBe(200);
    expect((yield* first.json) as { value: number }).toEqual({ value: 1 });

    const second = yield* requestUntilReady(
      client.post(`${urlA}/do/increment`),
    );
    expect((yield* second.json) as { value: number }).toEqual({ value: 2 });

    const fromB = yield* requestUntilReady(client.get(`${urlB}/do`));
    expect(fromB.status).toBe(200);
    expect((yield* fromB.json) as { value: number }).toEqual({ value: 2 });
  }).pipe(logLevel),
  { timeout: testTimeout },
);

test(
  "WorkerC hosts its own isolated Counter (writes from A/B are not visible from C)",
  Effect.gen(function* () {
    const { urlA, urlB, urlC } = yield* stack;
    const client = (yield* HttpClient.HttpClient).pipe(
      withCounterKey("isolation"),
    );

    yield* reset(urlA).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );
    yield* reset(urlB).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );
    yield* reset(urlC).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );

    // Increment via WorkerA and WorkerB (both route to WorkerA's hosted Counter).
    yield* requestUntilReady(client.post(`${urlA}/do/increment`));
    yield* requestUntilReady(client.post(`${urlB}/do/increment`));

    const fromA = yield* requestUntilReady(client.get(`${urlA}/do`));
    expect((yield* fromA.json) as { value: number }).toEqual({ value: 2 });

    // WorkerC hosts its own Counter namespace via `Counter.from(WorkerC)`,
    // so its DO instance has never been written to.
    const fromC = yield* requestUntilReady(client.get(`${urlC}/do`));
    expect((yield* fromC.json) as { value: number }).toEqual({ value: 0 });

    // Writes through WorkerC do not leak back to WorkerA/B either.
    yield* requestUntilReady(client.post(`${urlC}/do/increment`));
    yield* requestUntilReady(client.post(`${urlC}/do/increment`));
    yield* requestUntilReady(client.post(`${urlC}/do/increment`));

    const cAfter = yield* requestUntilReady(client.get(`${urlC}/do`));
    expect((yield* cAfter.json) as { value: number }).toEqual({ value: 3 });

    const aAfter = yield* requestUntilReady(client.get(`${urlA}/do`));
    expect((yield* aAfter.json) as { value: number }).toEqual({ value: 2 });
  }).pipe(logLevel),
  { timeout: testTimeout },
);

test(
  "Writes from WorkerB are visible from WorkerA (bidirectional cross-script DO)",
  Effect.gen(function* () {
    const { urlA, urlB } = yield* stack;
    const client = (yield* HttpClient.HttpClient).pipe(
      withCounterKey("bidirectional"),
    );

    yield* reset(urlA).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );
    yield* reset(urlB).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );

    yield* requestUntilReady(client.post(`${urlB}/d1/increment`));
    yield* requestUntilReady(client.post(`${urlB}/d1/increment`));
    yield* requestUntilReady(client.post(`${urlB}/do/increment`));

    const d1FromA = yield* requestUntilReady(client.get(`${urlA}/d1`));
    const doFromA = yield* requestUntilReady(client.get(`${urlA}/do`));

    expect((yield* d1FromA.json) as { value: number }).toEqual({ value: 2 });
    expect((yield* doFromA.json) as { value: number }).toEqual({ value: 1 });
  }).pipe(logLevel),
  { timeout: testTimeout },
);
