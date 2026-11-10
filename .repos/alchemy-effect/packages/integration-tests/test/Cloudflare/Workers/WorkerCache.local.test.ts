import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const getText = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (error) => error instanceof WorkerNotReady,
        schedule: Schedule.exponential("250 millis"),
        times: 20,
      }),
    );
    return yield* res.text;
  }).pipe(Effect.orDie);

/**
 * Workers Cache is not emulated locally — neither Worker-wide `cache` nor
 * per-entrypoint `entrypoints` (Miniflare's `cache` option is the Cache
 * API, not Workers Cache). `alchemy dev` accepts the config and invokes
 * every entrypoint on every request.
 */
test.provider(
  "entrypoints is accepted locally and every entrypoint runs uncached",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { worker } = yield* stack.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("entrypoint-cache-local", {
              main: pathe.resolve(import.meta.dirname, "fixtures/cache/entrypoint-worker.ts"),
              entrypoints: {
                default: { cache: { enabled: true } },
                Public: { cache: { enabled: true } },
              },
            }),
          };
        }),
      );
      expect(worker.url).toMatch(/^http:\/\/localhost:\d+/);

      const layers = (body: string) => /^gw:([^|]+)\|pub:(.+)$/.exec(body)?.slice(1);
      const first = layers(yield* getText(`${worker.url}/gateway`));
      const second = layers(yield* getText(`${worker.url}/gateway`));
      expect(first).toHaveLength(2);
      expect(second).toHaveLength(2);
      expect(second![0]).not.toEqual(first![0]);
      expect(second![1]).not.toEqual(first![1]);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 120_000,
  },
);
