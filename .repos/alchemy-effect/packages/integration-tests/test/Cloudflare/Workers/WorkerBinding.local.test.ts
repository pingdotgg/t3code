import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { A as AsyncCycleA, B as AsyncCycleB } from "./fixtures/async-circular-bindings/stack.ts";
import CycleWorkerALive, { WorkerA as CycleWorkerA } from "./fixtures/circular-bindings/workerA.ts";
import CycleWorkerBLive, { WorkerB as CycleWorkerB } from "./fixtures/circular-bindings/workerB.ts";
import BindingSelfWorkerLive, {
  BindingSelfWorker,
} from "./fixtures/worker-worker-binding/binding-self-worker.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

/**
 * GET a route, retrying until the freshly started workerd serves a 200 —
 * including 500s while a peer's dev-registry entry is still propagating.
 */
const getTextReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : res.text.pipe(
              Effect.flatMap((body) =>
                Effect.fail(new WorkerNotReady({ status: res.status, body })),
              ),
            ),
      ),
      Effect.retry({
        while: (e) => e._tag === "WorkerNotReady",
        schedule: Schedule.max([
          Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("2 seconds")]),
          Schedule.recurs(10),
        ]),
      }),
    );
    return yield* res.text;
  }).pipe(Effect.orDie);

/**
 * Under `alchemy dev` an Effect Worker's `bindWorker(Self)` resolves through
 * local workerd's `ctx.exports.default` loopback, the same path it takes
 * when deployed.
 */
test.provider(
  "local effect worker calls its own RPC method via bindWorker(Self)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        BindingSelfWorker.pipe(Effect.provide(BindingSelfWorkerLive)),
      );

      // Dev marker: served from the local dev proxy, no cloud deploy ran.
      expect(deployed.url).toMatch(/^http:\/\/localhost:\d+$/);

      expect(yield* getTextReady(`${deployed.url}/?name=erin`)).toBe("hello erin from self");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 180_000,
  },
);

/**
 * WorkerA binds the `Counter` hosted by WorkerB (`Counter.from(WorkerB)`)
 * while WorkerB binds WorkerA (`bindWorker(WorkerA)`). The two Workers are
 * cycle peers, so both are pre-created before either's outputs resolve —
 * WorkerA's pre-creation must not read WorkerB's still-unresolved
 * `workerName` from the cross-script Durable Object binding (#2146).
 */
test.provider(
  "local workers in a cycle bind a cross-script Durable Object",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const workerA = yield* CycleWorkerA;
          const workerB = yield* CycleWorkerB;
          return {
            urlA: workerA.url.as<string>(),
            urlB: workerB.url.as<string>(),
          };
        }).pipe(Effect.provide(Layer.mergeAll(CycleWorkerALive, CycleWorkerBLive))),
      );

      // Dev markers: both Workers serve from the local dev proxy, no cloud
      // deploy ran.
      expect(deployed.urlA).toMatch(/^http:\/\/localhost:\d+$/);
      expect(deployed.urlB).toMatch(/^http:\/\/localhost:\d+$/);

      // A request through WorkerA increments WorkerB's Counter, and WorkerB
      // reads the same instance from its own namespace.
      const key = crypto.randomUUID();
      expect(JSON.parse(yield* getTextReady(`${deployed.urlA}/?key=${key}`))).toEqual({
        value: 1,
      });
      expect(JSON.parse(yield* getTextReady(`${deployed.urlB}/?key=${key}`))).toEqual({
        value: 1,
      });

      // The other edge of the cycle: WorkerB calls WorkerA.
      expect(yield* getTextReady(`${deployed.urlB}/worker-a`)).toBe("WorkerA");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 180_000,
  },
);

/**
 * Two plain async Workers bind each other: A binds B's default entrypoint
 * and B binds A's named `Callbacks` entrypoint. Declaring the stack used to
 * recurse between the two `env` declarations until the heap ran out (#2672).
 */
test.provider(
  "local async workers in a cycle call each other",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const a = yield* AsyncCycleA;
          const b = yield* AsyncCycleB;
          return { urlA: a.url.as<string>(), urlB: b.url.as<string>() };
        }),
      );

      expect(deployed.urlA).toMatch(/^http:\/\/localhost:\d+$/);
      expect(deployed.urlB).toMatch(/^http:\/\/localhost:\d+$/);

      // A → B.start → A's Callbacks.done: both edges of the cycle.
      expect(yield* getTextReady(`${deployed.urlA}/?id=7`)).toBe("a got 7");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 180_000,
  },
);
