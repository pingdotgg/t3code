import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import EntrypointPropsWorker from "./fixtures/entrypoint-props/effect-worker.ts";
import { AsyncEntrypointPropsWorker } from "./fixtures/entrypoint-props/stack.ts";
import type { Api } from "./fixtures/worker-entrypoint-binding/entrypoint-target-worker.ts";

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
            env: {
              SELF: Cloudflare.WorkerEntrypoint<Api>({
                entrypoint: "Api",
                props: { tenant: "self" },
              }),
            },
          });
          const caller = yield* Cloudflare.Worker("entrypoint-local-caller", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/worker-entrypoint-binding/entrypoint-caller-worker.ts",
            ),
            env: {
              API: Cloudflare.WorkerEntrypoint<Api>(target, {
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

      const greeting = yield* getReady(`${deployed.caller.url}/greet?name=alice`).pipe(
        Effect.flatMap((res) => res.text),
      );
      expect(greeting).toBe("hello alice from Api");

      const props = (yield* getReady(`${deployed.caller.url}/props`).pipe(
        Effect.flatMap((res) => res.json),
      )) as Record<string, unknown>;
      expect(props).toEqual({ tenant: "acme" });

      // The target's own `Api`, bound with `WorkerEntrypoint({ entrypoint, props })`.
      const selfGreeting = yield* getReady(`${deployed.target.url}/self-greet?name=bob`).pipe(
        Effect.flatMap((res) => res.text),
      );
      expect(selfGreeting).toBe("hello bob from Api");

      const selfProps = (yield* getReady(`${deployed.target.url}/self-props`).pipe(
        Effect.flatMap((res) => res.json),
      )) as Record<string, unknown>;
      expect(selfProps).toEqual({ tenant: "self" });

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 120_000,
  },
);

/** GET a route once the freshly started workerd serves a 200, as text. */
const getTextReady = (url: string) =>
  getReady(url).pipe(
    Effect.flatMap((res) => res.text),
    Effect.orDie,
  );

/**
 * Under `alchemy dev`, local workerd serves `ctx.props` and the
 * `ctx.exports` loopback the same way the deployed Worker does.
 */
test.provider(
  "local effect and async workers read ctx.props and mint self entrypoint stubs with props",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(EntrypointPropsWorker);

      // Dev marker: served from the local dev proxy, no cloud deploy ran.
      expect(deployed.url).toMatch(/^http:\/\/localhost:\d+$/);

      const tenant = `props=${JSON.stringify({ tenant: "acme" })}`;
      expect(yield* getTextReady(`${deployed.url}/props`)).toBe("props={}");
      expect(yield* getTextReady(`${deployed.url}/mint`)).toBe(`via-worker:${tenant}`);
      expect(yield* getTextReady(`${deployed.url}/mint-do`)).toBe(`via-do:${tenant}`);
      expect(yield* getTextReady(`${deployed.url}/missing`)).toBe(
        "EntrypointUnavailableError:Missing",
      );

      yield* stack.destroy();

      const asyncDeployed = yield* stack.deploy(AsyncEntrypointPropsWorker());
      expect(asyncDeployed.url).toMatch(/^http:\/\/localhost:\d+$/);
      expect(yield* getTextReady(`${asyncDeployed.url}/props`)).toBe("props={}");
      expect(yield* getTextReady(`${asyncDeployed.url}/mint`)).toBe(`via-worker:${tenant}`);
      expect(yield* getTextReady(`${asyncDeployed.url}/mint-named`)).toBe(`via-named:${tenant}`);
      expect(yield* getTextReady(`${asyncDeployed.url}/mint-do`)).toBe(`via-do:${tenant}`);
      expect(yield* getTextReady(`${asyncDeployed.url}/missing`)).toBe("undefined:Missing");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 180_000,
  },
);
