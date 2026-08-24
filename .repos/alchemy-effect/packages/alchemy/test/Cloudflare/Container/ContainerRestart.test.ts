import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import RestartStack from "./fixtures/restart/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Image build + push + worker/DO deploy comfortably exceeds the default hook
// budget, and a restart adds another cold start on top, so be generous.
const HOOK_TIMEOUT = 600_000;
const TEST_TIMEOUT = 300_000;

const DEPLOY_PLACEHOLDER = "Alchemy worker is being deployed...";

// Force `Connection: close` so each attempt opens a fresh connection and can
// land on an edge that already has the new deploy / restarted container.
const freshConn = HttpClient.mapRequest(
  HttpClientRequest.setHeader("connection", "close"),
);

const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

// Retry a route until it answers 200 with a body containing `expected`,
// rejecting transient non-200s and the pre-create deploy stub. This is how we
// assert "the container is up and serving" both initially and after a restart.
const fetchReady = (url: string, expected: string) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    return yield* client.get(url).pipe(
      Effect.flatMap((r) =>
        r.status !== 200
          ? Effect.fail(new Error(`not ready: ${r.status}`))
          : Effect.flatMap(r.text, (body) =>
              body.includes(DEPLOY_PLACEHOLDER) || !body.includes(expected)
                ? Effect.fail(new Error(`not ready: got ${body}`))
                : Effect.succeed(body),
            ),
      ),
      Effect.timeout("30 seconds"),
      Effect.retry({ schedule: readinessSchedule, times: 40 }),
    );
  });

// Fire a single GET and return its body (used for /stop, /crash).
const hit = (url: string) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    const res = yield* client.get(url);
    return yield* res.text;
  });

// Poll `/running` until the reported state matches `want`. Used to confirm the
// container actually went down before we assert the next request restarts it,
// so the test exercises the real restart path (not a still-warm container).
const waitRunning = (baseUrl: string, name: string, want: boolean) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    return yield* client
      .get(`${baseUrl}/running?name=${encodeURIComponent(name)}`)
      .pipe(
        Effect.flatMap((r) =>
          r.status !== 200
            ? Effect.fail(new Error(`running not ready: ${r.status}`))
            : Effect.flatMap(r.json, (body) => {
                const running = (body as { running?: boolean }).running;
                return running === want
                  ? Effect.succeed(running)
                  : Effect.fail(new Error(`running=${running}, want ${want}`));
              }),
        ),
        Effect.timeout("15 seconds"),
        Effect.retry({ schedule: readinessSchedule, times: 40 }),
      );
  });

/**
 * Auto-restart: a Durable Object's container that has stopped or crashed must
 * be transparently restarted on the next request. Regression coverage for the
 * `readyPorts` cache going stale — previously a port confirmed ready once was
 * never re-probed and `ensureRunning` was skipped, so a stopped container was
 * never restarted.
 */
describe("container auto-restart", () => {
  const stack = beforeAll(deploy(RestartStack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(RestartStack), {
    timeout: HOOK_TIMEOUT,
  });

  test(
    "restarts the container after it is stopped (destroy)",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const name = "stop";

      // Start + confirm up.
      expect(yield* fetchReady(`${url}/ping?name=${name}`, "pong")).toContain(
        "pong",
      );

      // Hard-stop it, then confirm it is actually down before re-pinging — so
      // the next ping must go through the restart path.
      yield* hit(`${url}/stop?name=${name}`);
      yield* waitRunning(url, name, false);

      // Next request transparently restarts it.
      expect(yield* fetchReady(`${url}/ping?name=${name}`, "pong")).toContain(
        "pong",
      );
      expect(yield* waitRunning(url, name, true)).toBe(true);
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );

  test(
    "restarts the container after it crashes (non-zero exit)",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const name = "crash";

      expect(yield* fetchReady(`${url}/ping?name=${name}`, "pong")).toContain(
        "pong",
      );

      // Make the container process exit on its own, then wait for the monitor
      // to observe the exit (running === false).
      yield* hit(`${url}/crash?name=${name}`);
      yield* waitRunning(url, name, false);

      // Next request transparently restarts it.
      expect(yield* fetchReady(`${url}/ping?name=${name}`, "pong")).toContain(
        "pong",
      );
      expect(yield* waitRunning(url, name, true)).toBe(true);
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );
});
