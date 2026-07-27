import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import RandomEnvWorker from "./fixtures/random-env/worker.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

interface RandomEnvBody {
  resolvedType: string;
  isHexSecret: boolean;
}

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

/**
 * Pins that an `Alchemy.Random` output bound during init resolves to its
 * minted value under the LOCAL worker provider, the same as in a real
 * deploy.
 *
 * Regression shape (beta.62, fixed by #829's request-time env reification):
 * the runtime accessor read of an output-bound env entry came back
 * `undefined` under `alchemy dev` while the same code worked deployed —
 * the first consumer crashed far from the cause (e.g.
 * `Redacted.value(undefined)` dying inside effect internals). Nothing else
 * in the suite exercises a generated-secret Output accessor under the
 * local provider, so this pins the deploy/dev parity directly.
 */
test.provider(
  "a Random output bound at init resolves under the local provider",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { worker } = yield* stack.deploy(
        Effect.gen(function* () {
          const w = yield* RandomEnvWorker;
          return { worker: w };
        }),
      );

      const client = yield* HttpClient.HttpClient;
      const body = yield* Effect.gen(function* () {
        const res = yield* client.get(worker.url!).pipe(
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
        return (yield* res.json) as unknown as RandomEnvBody;
      }).pipe(Effect.orDie);

      // The runtime read must observe the minted 32-byte hex secret —
      // never `undefined`.
      expect(body.resolvedType).toBe("string");
      expect(body.isHexSecret).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
