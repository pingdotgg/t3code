import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "./fixtures/dynamic-worker-loader/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

// Fresh workers.dev URLs serve Cloudflare's placeholder page for a few seconds
// after deploy. Retry until the worker (and its dynamically-loaded child)
// answer 200, surfacing the body if not so a real failure isn't masked.
const readJson = (url: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.get(url)),
    Effect.flatMap((res) =>
      res.status === 200
        ? res.json
        : res.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(new WorkerNotReady({ status: res.status, body })),
            ),
          ),
    ),
    Effect.retry({
      while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(20),
      ]),
    }),
  );

// The dynamic worker's hit counter lives in module scope, so an isolate id
// reused across test attempts (the runner retries) or runs keeps counting.
// Mint a fresh id per attempt so `hits` always starts at 1.
const freshId = (prefix: string) =>
  Effect.sync(() => `${prefix}-${crypto.randomUUID().slice(0, 8)}`);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "async worker loads and proxies to a dynamic worker via env binding",
  Effect.gen(function* () {
    const { asyncWorkerUrl } = yield* stack;
    const body = yield* readJson(asyncWorkerUrl);
    expect(body).toMatchObject({ mode: "async", ok: true });
  }),
  { timeout: 180_000 },
);

test(
  "effect worker loads and proxies to a dynamic worker via yield* loader",
  Effect.gen(function* () {
    const { effectWorkerUrl } = yield* stack;
    const body = yield* readJson(effectWorkerUrl);
    expect(body).toMatchObject({ mode: "effect", ok: true });
  }),
  { timeout: 180_000 },
);

test(
  "effect worker get() fetch proxies to a cached dynamic worker",
  Effect.gen(function* () {
    const { getWorkerUrl } = yield* stack;
    const id = yield* freshId("stub");
    const body = yield* readJson(`${getWorkerUrl}/?id=${id}`);
    expect(body).toMatchObject({ id, hits: 1 });
  }),
  { timeout: 180_000 },
);

test(
  "effect worker get() reuses the isolate for the same id",
  Effect.gen(function* () {
    const { getWorkerUrl } = yield* stack;
    const id = yield* freshId("reuse");
    const first = yield* readJson(`${getWorkerUrl}/?id=${id}`);
    expect(first).toMatchObject({ id, hits: 1 });
    // `get()` only reuses an isolate within the same colo/process, so two
    // back-to-back requests can occasionally be served by two fresh
    // isolates (both reporting `hits: 1`). Any response with `hits >= 2`
    // proves module state survived across requests, i.e. the isolate was
    // reused — poll for that instead of asserting the second request exactly.
    const reused = yield* readJson(`${getWorkerUrl}/?id=${id}`).pipe(
      Effect.repeat({
        until: (body) => (body as { hits: number }).hits >= 2,
        schedule: Schedule.spaced("500 millis"),
        times: 10,
      }),
    );
    expect(reused).toMatchObject({ id });
    expect((reused as { hits: number }).hits).toBeGreaterThanOrEqual(2);
  }),
  { timeout: 180_000 },
);

test(
  "effect worker get() getEntrypoint() fetch works",
  Effect.gen(function* () {
    const { getWorkerUrl } = yield* stack;
    const id = yield* freshId("named");
    const body = yield* readJson(`${getWorkerUrl}/?id=${id}&entrypoint=1`);
    expect(body).toMatchObject({ id, hits: 1 });
  }),
  { timeout: 180_000 },
);

// `globalOutbound: null` must reach the runtime as `null` — coercing it to
// `undefined` (the old `?.raw` behavior) silently restores default outbound
// access for workers meant to be sandboxed (#746). The fixture's dynamic
// worker attempts an outbound fetch and reports whether the runtime allowed
// it.
test(
  "dynamic worker loaded with globalOutbound: null cannot reach the network",
  Effect.gen(function* () {
    const { effectWorkerUrl } = yield* stack;
    const body = yield* readJson(`${effectWorkerUrl}/outbound/sandboxed`);
    expect(body).toMatchObject({ outbound: "blocked" });
  }),
  { timeout: 180_000 },
);

test(
  "dynamic worker loaded without globalOutbound has default network access",
  Effect.gen(function* () {
    const { effectWorkerUrl } = yield* stack;
    const body = yield* readJson(`${effectWorkerUrl}/outbound/open`);
    expect(body).toMatchObject({ outbound: "allowed", status: 200 });
  }),
  { timeout: 180_000 },
);
