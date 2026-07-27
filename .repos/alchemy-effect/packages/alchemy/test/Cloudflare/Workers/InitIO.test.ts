import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import InitIOWorker from "./fixtures/init-io/worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = Alchemy.Stack(
  "InitIOTestStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* InitIOWorker;
    return { url: worker.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

interface InitIOBody {
  nonce: string;
  traceLength: number;
  hasUag: boolean;
  initFetches: number;
}

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

/**
 * Pins the init-phase I/O contract: one-shot async I/O in a Layer build
 * (here a real `fetch` of cloudflare.com/cdn-cgi/trace) runs exactly once
 * per isolate, and the cached plain value serves every event — sequential
 * and concurrent. A regression to per-event builds would report
 * `initFetches > 1` and a fresh `nonce` per request; a broken cross-request
 * build would fail the concurrent batch outright.
 */
test(
  "async I/O in a layer build runs once per isolate and serves every event",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const get = Effect.gen(function* () {
      const res = yield* client.get(url).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.succeed(res)
            : Effect.fail(new WorkerNotReady({ status: res.status })),
        ),
        Effect.retry({
          while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
          schedule: Schedule.max([
            Schedule.exponential("500 millis"),
            Schedule.recurs(10),
          ]),
        }),
      );
      return (yield* res.json) as unknown as InitIOBody;
    }).pipe(Effect.orDie);

    const first = yield* get;
    const second = yield* get;
    const concurrent = yield* Effect.all(
      Array.from({ length: 6 }, () => get),
      { concurrency: "unbounded" },
    );

    for (const body of [first, second, ...concurrent]) {
      // The layer's fetch really ran and produced a usable value...
      expect(body.hasUag).toBe(true);
      expect(body.traceLength).toBeGreaterThan(0);
      expect(body.nonce).toMatch(/^[0-9a-f-]{36}$/);
      // ...exactly once on whichever isolate served this event, no matter
      // how many events that isolate has handled.
      expect(body.initFetches).toBe(1);
    }
  }).pipe(logLevel),
  { timeout: 180_000 },
);
