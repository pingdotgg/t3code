import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import AnonAccessWorker from "./fixtures/access-context/anon-worker.ts";
import AuthedAccessWorker from "./fixtures/access-context/authed-worker.ts";

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

/** GET a route, retrying until the freshly started workerd serves a 200. */
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
    return (yield* res.json) as Record<string, unknown>;
  }).pipe(Effect.orDie);

/**
 * Pins the `dev.access` simulation of `ctx.access` (the alchemy equivalent
 * of wrangler's `access.dev` config): a worker with `dev.access` sees a
 * defined `ctx.access` carrying the configured aud, and `getIdentity()`
 * resolves the configured identity — while a worker without the config sees
 * `ctx.access === undefined` (unauthenticated).
 */
test.provider("dev.access simulates ctx.access locally", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        const authed = yield* AuthedAccessWorker;
        const anon = yield* AnonAccessWorker;
        return { authed, anon };
      }),
    );

    // Dev markers: both workers serve from the local dev proxy — no cloud
    // deploy ran.
    expect(deployed.authed.url).toMatch(/^http:\/\/localhost:\d+$/);
    expect(deployed.anon.url).toMatch(/^http:\/\/localhost:\d+$/);
    // No cloud script exists in dev — the local provider fabricates a
    // `dev:`-marked identity (mode switches replace the resource, so the
    // two identities never mix).
    expect(deployed.authed.workerId).toMatch(/^dev:/);

    const authed = yield* getJsonReady(deployed.authed.url!);
    expect(authed).toEqual({
      authenticated: true,
      aud: "test-aud",
      email: "dev@alchemy.test",
      groups: [{ id: "g1", name: "devs" }],
    });

    const anon = yield* getJsonReady(deployed.anon.url!);
    expect(anon).toEqual({ authenticated: false });

    yield* stack.destroy();
  }).pipe(logLevel),
);
