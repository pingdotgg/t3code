import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "./fixtures/worker-worker-binding/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// Cold-start retry — fresh `workers.dev` URLs take a few seconds to start
// answering 200, so the very first request rides this schedule. Cap the
// exponential at 3s: uncapped, the doubling sleeps blow through the test
// timeout in a single wait after ~7 misses, even though the edge would
// have propagated moments later.
const coldStartRetry = Effect.retry({
  schedule: Schedule.min([
    Schedule.exponential("500 millis"),
    Schedule.spaced("3 seconds"),
  ]),
  times: 30,
});

test(
  "target worker's own fetch handler responds",
  Effect.gen(function* () {
    const { targetUrl } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client.get(targetUrl).pipe(coldStartRetry);
    expect(res.status).toBe(200);
    expect(yield* res.text).toBe("hello from BindingTargetWorker");
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "async caller can call target's RPC method via service binding",
  Effect.gen(function* () {
    const { asyncCallerUrl } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client
      .get(`${asyncCallerUrl}/?name=alice`)
      .pipe(coldStartRetry);
    expect(res.status).toBe(200);
    expect(yield* res.text).toBe("hello alice");
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "effect caller can call target's RPC method via bindWorker",
  Effect.gen(function* () {
    const { effectCallerUrl } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client
      .get(`${effectCallerUrl}/?name=bob`)
      .pipe(coldStartRetry);
    expect(res.status).toBe(200);
    expect(yield* res.text).toBe("hello bob");
  }).pipe(logLevel),
  { timeout: 180_000 },
);
