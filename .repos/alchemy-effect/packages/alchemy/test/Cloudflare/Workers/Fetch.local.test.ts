import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import FetchCallerWorker from "./fixtures/fetch-binding/fetch-caller.ts";
import FetchTargetWorker from "./fixtures/fetch-binding/fetch-target.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

/**
 * GET a route, retrying until the freshly started workerd serves a 200 —
 * including 500s from the caller while the target's dev-registry entry is
 * still propagating to the caller's service-binding proxy.
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
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(10),
        ]),
      }),
    );
    return yield* res.text;
  }).pipe(Effect.orDie);

/**
 * Pins the `Cloudflare.Workers.Fetch` capability: the caller registers a
 * service binding for the *target* worker (named by the target's LogicalId,
 * pointing at the target's workerName) and fetches through it with the
 * HttpClient-shaped runtime client. Under `alchemy dev` the binding resolves
 * through the dev registry proxy between two locally-running workerds, so a
 * green roundtrip proves both the deploy-time registration and the
 * `env[worker.LogicalId]` runtime lookup line up — the exact pair the
 * self-binding bug broke.
 */
test.provider(
  "local caller fetches local target through the Fetch service binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const target = yield* FetchTargetWorker;
          const caller = yield* FetchCallerWorker;
          return { target, caller };
        }),
      );

      // Dev markers: both workers serve from the local dev proxy — no cloud
      // deploy ran.
      expect(deployed.target.url).toMatch(/^http:\/\/localhost:\d+$/);
      expect(deployed.caller.url).toMatch(/^http:\/\/localhost:\d+$/);

      // The target answers directly.
      expect(yield* getTextReady(`${deployed.target.url}/?name=direct`)).toBe(
        "fetch-binding-target: hello direct",
      );

      // The roundtrip through the caller's Fetch service binding.
      expect(yield* getTextReady(`${deployed.caller.url}/?name=alice`)).toBe(
        "caller saw: fetch-binding-target: hello alice",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
