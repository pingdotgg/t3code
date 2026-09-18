import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import DynamicLoaderGetWorker from "./fixtures/dynamic-worker-loader/get-worker.ts";

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

const getJsonReady = (url: string) =>
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
    return yield* res.json;
  }).pipe(Effect.orDie);

/**
 * Deploys an Effect-native Worker that calls `loader.get()` then
 * `worker.fetch()` against local workerd. Native get() returns a WorkerStub
 * (fetcher is getEntrypoint()); wrapping it as a Fetcher made fetch throw
 * (#1382). A second request with the same id must reuse the isolate.
 */
test.provider(
  "local worker get() fetch works and reuses the isolate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* DynamicLoaderGetWorker;
          return { worker };
        }),
      );

      expect(deployed.worker.url).toMatch(/^http:\/\/localhost:\d+$/);

      const first = (yield* getJsonReady(
        `${deployed.worker.url}/?id=local-reuse`,
      )) as { id: string; hits: number };
      expect(first).toEqual({ id: "local-reuse", hits: 1 });

      const second = (yield* getJsonReady(
        `${deployed.worker.url}/?id=local-reuse`,
      )) as { id: string; hits: number };
      expect(second).toEqual({ id: "local-reuse", hits: 2 });

      const named = (yield* getJsonReady(
        `${deployed.worker.url}/?id=local-named&entrypoint=1`,
      )) as { id: string; hits: number };
      expect(named).toEqual({ id: "local-named", hits: 1 });

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
