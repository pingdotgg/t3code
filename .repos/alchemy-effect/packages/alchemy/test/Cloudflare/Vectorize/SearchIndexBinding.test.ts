import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { poll } from "@/Util/poll.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { HttpClientResponse } from "effect/unstable/http";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "./fixtures/stack.ts";

/**
 * End-to-end test of the `Cloudflare.Vectorize` native worker binding against a
 * real Cloudflare Worker + Vectorize index, covering BOTH invocation styles:
 *
 *  - effect-worker: `yield* Cloudflare.Vectorize.SearchIndex(index)` inside a
 *    `Cloudflare.Worker` init, binding provided via `SearchIndexBinding`.
 *  - async-worker:  the index declared on the Worker `env`, used as the native
 *    runtime `Vectorize` binding from a plain `async fetch`.
 *
 * Both workers share ONE index (vectors are id-prefixed by style so they stay
 * independent) and are driven by a single `exercise(label, baseUrl)` flow that
 * upserts → describes → queries → filtered-queries → getByIds. Vectorize
 * mutations are eventually consistent, so reads are polled until visible.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Fresh workers.dev URLs take a few seconds to start serving 200s, and edge
// propagation can still transiently 404/500 individual route hits after the
// script is resolvable. Cap each backoff at 5s and stop after 12 attempts
// (~45s worst case) so a genuine failure surfaces instead of hanging.
const readinessRetry = {
  schedule: Schedule.max([
    Schedule.min([
      Schedule.exponential("500 millis"),
      Schedule.spaced("5 seconds"),
    ]),
    Schedule.recurs(12),
  ]),
} as const;

const getJson = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((res) => res.json),
    Effect.retry(readinessRetry),
  );

const postJson = (url: string) =>
  HttpClient.post(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((res) => res.json),
    Effect.retry(readinessRetry),
  );

/**
 * Drives the full Vectorize client surface against one worker and asserts.
 * `label` is the id prefix this worker uses (`effect` / `async`).
 */
const exercise = (label: string, baseUrl: string) =>
  Effect.gen(function* () {
    // Gate on /health first to prove the script is resolvable.
    yield* HttpClient.get(`${baseUrl}/health`).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.retry({
        schedule: Schedule.max([
          Schedule.exponential("500 millis"),
          Schedule.recurs(20),
        ]),
      }),
    );

    const upsertRes = yield* postJson(`${baseUrl}/upsert`);
    expect(upsertRes).toMatchObject({ mutationId: expect.any(String) });

    const describeRes = yield* getJson(`${baseUrl}/describe`);
    expect(describeRes).toMatchObject({ dimensions: 32 });

    // Mutations are async/eventually consistent — poll until this worker's
    // three vectors are visible.
    const queryBody = yield* poll({
      description: `[${label}] GET /query returns the three upserted vectors`,
      effect: getJson(`${baseUrl}/query`).pipe(
        Effect.map((body) => body as { count: number; ids: string[] }),
      ),
      predicate: (body) => body.count >= 3,
    });
    expect(queryBody.count).toBeGreaterThanOrEqual(3);
    // The query vector equals `${label}-a` exactly, so it's the top match.
    expect(queryBody.ids[0]).toBe(`${label}-a`);

    const getRes = yield* poll({
      description: `[${label}] GET /get returns the two upserted vectors`,
      effect: getJson(`${baseUrl}/get`).pipe(
        Effect.map((body) => body as { ids: string[] }),
      ),
      predicate: (body) => body.ids.length === 2,
    });
    expect(getRes).toEqual({ ids: [`${label}-a`, `${label}-b`] });

    // Metadata-filtered query: only this worker's `kind: "second"` vector
    // (`${label}-b`) should come back.
    const filteredBody = yield* poll({
      description: `[${label}] GET /query-filtered returns the second vector`,
      effect: getJson(`${baseUrl}/query-filtered`).pipe(
        Effect.map(
          (body) => body as { count: number; ids: string[]; kinds: string[] },
        ),
      ),
      predicate: (body) => body.ids.length === 1 && body.kinds.length === 1,
    });
    expect(filteredBody.ids).toEqual([`${label}-b`]);
    expect(filteredBody.kinds).toEqual(["second"]);
  }).pipe(logLevel);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "effect-worker: SearchIndex(index) exercises the client surface",
  Effect.gen(function* () {
    const { effectWorkerUrl } = yield* stack;
    yield* exercise("effect", effectWorkerUrl);
  }),
  { timeout: 240_000 },
);

test(
  "async-worker: env Vectorize binding exercises the client surface",
  Effect.gen(function* () {
    const { asyncWorkerUrl } = yield* stack;
    yield* exercise("async", asyncWorkerUrl);
  }),
  { timeout: 240_000 },
);
