import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import InitIOProbe from "./init-io-probe.ts";

const { test } = Test.make({ providers: AWS.providers() });

interface InitIOBody {
  nonce: string;
  traceLength: number;
  hasUag: boolean;
  initFetches: number;
}

class FunctionNotReady extends Data.TaggedError("FunctionNotReady")<{
  status: number;
}> {}

/**
 * Pins the init-phase I/O contract on Lambda: one-shot async I/O in a
 * Layer build (a real `fetch` at cold start, run under the instance scope)
 * completes once per sandbox and the cached plain value serves every
 * invocation.
 */
test.provider(
  "async I/O in a layer build runs once per sandbox and serves every invocation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* InitIOProbe;
        }),
      );

      const client = yield* HttpClient.HttpClient;
      const get = Effect.gen(function* () {
        const res = yield* client.get(fn.functionUrl!).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? Effect.succeed(res)
              : Effect.fail(new FunctionNotReady({ status: res.status })),
          ),
          Effect.retry({
            while: (e): e is FunctionNotReady => e instanceof FunctionNotReady,
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
        Array.from({ length: 4 }, () => get),
        { concurrency: "unbounded" },
      );

      for (const body of [first, second, ...concurrent]) {
        expect(body.hasUag).toBe(true);
        expect(body.traceLength).toBeGreaterThan(0);
        expect(body.nonce).toMatch(/^[0-9a-f-]{36}$/);
        // Exactly one init fetch on whichever sandbox served this
        // invocation, no matter how many invocations it has handled.
        expect(body.initFetches).toBe(1);
      }

      yield* stack.destroy();

      // Out-of-band proof the destroy removed the function from the cloud.
      yield* Lambda.getFunction({ FunctionName: fn.functionName }).pipe(
        Effect.flatMap(() =>
          Effect.fail(new Error(`Function ${fn.functionName} still exists`)),
        ),
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.exponential(500),
            Schedule.recurs(8),
          ]),
        }),
      );
    }),
  { timeout: 600_000 },
);
