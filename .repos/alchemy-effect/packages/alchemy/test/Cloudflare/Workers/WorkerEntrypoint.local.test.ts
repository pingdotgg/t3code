import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";

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
}> {}

const getReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
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
  }).pipe(Effect.orDie);

/**
 * Under `alchemy dev` both Workers run on local workerd, and the
 * `Cloudflare.WorkerEntrypoint` env entry lowers to a local service
 * designator with `entrypoint` AND `props` — unlike live deploys, workerd
 * delivers `ctx.props` today, so this test covers the full contract.
 */
test.provider(
  "WorkerEntrypoint binding targets the named entrypoint and delivers ctx.props locally",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const target = yield* Cloudflare.Worker("entrypoint-local-target", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/worker-entrypoint-binding/entrypoint-target-worker.ts",
            ),
          });
          const caller = yield* Cloudflare.Worker("entrypoint-local-caller", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/worker-entrypoint-binding/entrypoint-caller-worker.ts",
            ),
            env: {
              API: Cloudflare.WorkerEntrypoint(target, {
                entrypoint: "Api",
                props: { tenant: "acme" },
              }),
            },
          });
          return { target, caller };
        }),
      );

      // Local dev URLs — proof no cloud call ran.
      expect(deployed.caller.url).toMatch(/^http:\/\/localhost:\d+$/);

      const greeting = yield* getReady(
        `${deployed.caller.url}/greet?name=alice`,
      ).pipe(Effect.flatMap((res) => res.text));
      expect(greeting).toBe("hello alice from Api");

      const props = (yield* getReady(`${deployed.caller.url}/props`).pipe(
        Effect.flatMap((res) => res.json),
      )) as Record<string, unknown>;
      expect(props).toEqual({ tenant: "acme" });

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
