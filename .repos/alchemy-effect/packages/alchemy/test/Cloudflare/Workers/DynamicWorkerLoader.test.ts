import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
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
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.both(Schedule.recurs(20)),
      ),
    }),
  );

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
