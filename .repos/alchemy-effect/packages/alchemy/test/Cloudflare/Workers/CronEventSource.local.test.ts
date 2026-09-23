import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import CronTestWorker from "./fixtures/cron/cron-worker.ts";

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

/**
 * Under `alchemy dev` the Worker's cron triggers are wired into the local
 * runtime: cloudflare-runtime starts a Node-side timer per expression AND
 * exposes Miniflare's manual trigger route
 * (`/cdn-cgi/handler/scheduled?cron=...&time=...`) on the local worker URL.
 *
 * The local timer for `* * * * *` only fires on minute boundaries, so this
 * test drives the manual route instead of waiting — the route exercises the
 * exact same entry-worker -> user-worker `scheduled()` dispatch the timer
 * uses (the timer itself is covered in cloudflare-runtime's own suite,
 * `test/globals/Scheduled.test.ts`).
 */
test.provider(
  "local cron worker fires scheduled() via the manual trigger route",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* CronTestWorker;
          return { worker };
        }),
      );

      // The dev URL is the local proxy — proof no cloud deploy ran.
      expect(deployed.worker.url).toMatch(/^http:\/\/localhost:\d+$/);
      // The cron registered by the `cron()` event source is recorded on the
      // local attributes, exactly like the live provider records it.
      expect(deployed.worker.crons).toContain("* * * * *");

      const url = deployed.worker.url;
      const client = yield* HttpClient.HttpClient;

      // Reset the counter DO. Doubles as a readiness probe for the first
      // request against a freshly started workerd.
      yield* Effect.gen(function* () {
        const res = yield* client.post(`${url}/reset`);
        if (res.status !== 200) {
          return yield* Effect.fail(new WorkerNotReady({ status: res.status }));
        }
      }).pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );

      // Trigger the fire manually. `cron` must match the registered
      // expression exactly — the runtime bridge dispatches scheduled events
      // to listeners by expression.
      const scheduledTime = Date.now();
      const trigger = yield* client.post(
        `${url}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("* * * * *")}&time=${scheduledTime}`,
      );
      expect(trigger.status).toBe(200);
      expect(yield* trigger.text).toBe("ok");

      // The handler records `controller.scheduledTime` on the DO; poll the
      // worker's /times route until the fire shows up (bounded).
      const times = yield* Effect.gen(function* () {
        const res = yield* client.get(`${url}/times`);
        if (res.status !== 200) return [];
        const body = (yield* res.json) as { times?: unknown };
        return Array.isArray(body.times) ? body.times : [];
      }).pipe(
        Effect.catch(() => Effect.succeed([] as unknown[])),
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (times): boolean => times.length > 0,
          times: 10,
        }),
      );

      expect(times).toContain(scheduledTime);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
