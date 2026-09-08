import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

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
}> {}

const getJsonReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        // Cap the backoff: an uncapped exponential over 10 recurs sums to
        // ~8.5 minutes and turns a persistent non-200 into an apparent hang.
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(10),
        ]),
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

const scriptFor = (version: string) => `export default {
  async fetch() {
    return Response.json({ version: "${version}" });
  },
};`;

/**
 * Inline \`script:\` workers serve under the local provider without the
 * bundler (the string IS the module), and editing the script restarts the
 * instance via the hashed config. This used to hang silently: \`start\`
 * returned the proxy URL while the bundler waited forever on a missing
 * \`main\`.
 */
test.provider(
  "inline script worker serves locally and restarts on script change",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (version: string) =>
        stack.deploy(
          Effect.gen(function* () {
            return {
              worker: yield* Cloudflare.Worker("script-local-worker", {
                script: scriptFor(version),
              }),
            };
          }),
        );

      const v1 = yield* deploy("v1");

      // The local provider serves from the dev proxy — proof no cloud call
      // ran.
      expect(v1.worker.url).toMatch(/^http:\/\/localhost:\d+$/);

      const first = (yield* getJsonReady(`${v1.worker.url}`)) as {
        version: string;
      };
      expect(first.version).toBe("v1");

      // Changing the script changes the config hash — the instance restarts
      // with the new module.
      const v2 = yield* deploy("v2");
      const second = (yield* getJsonReady(`${v2.worker.url}`)) as {
        version: string;
      };
      expect(second.version).toBe("v2");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
