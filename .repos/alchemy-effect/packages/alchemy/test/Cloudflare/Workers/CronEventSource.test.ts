import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import CronTestWorker from "./fixtures/cron-worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = Alchemy.Stack(
  "CronEventSourceStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* CronTestWorker;
    return {
      url: worker.url.as<string>(),
      crons: worker.crons,
    };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test.skipIf(!!process.env.NO_SLOW_TESTS)(
  "deployed worker fires the scheduled handler on its cron trigger",
  Effect.gen(function* () {
    const { url, crons } = yield* stack;
    expect(crons).toContain("* * * * *");

    const client = yield* HttpClient.HttpClient;

    // Reset any leftover state from prior runs. Doubles as a readiness probe —
    // a fresh workers.dev URL can take a few seconds to start serving 200s.
    yield* Effect.gen(function* () {
      const res = yield* client.post(`${url}/reset`);
      if (res.status !== 200) {
        return yield* Effect.fail(new Error(`Worker not ready: ${res.status}`));
      }
    }).pipe(
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 10,
      }),
    );
    const resetAt = Date.now();

    // Cloudflare cron granularity is one minute and there's some propagation
    // delay after deploy, so we poll up to ~3 minutes for the first fire.
    const times = yield* Effect.gen(function* () {
      const res = yield* client.get(`${url}/times`);
      if (res.status !== 200) return [];
      const body = (yield* res.json) as { times?: unknown };
      if (!Array.isArray(body.times)) return [];
      return body.times.filter((t) => t >= resetAt);
    }).pipe(
      Effect.catch(() => Effect.succeed([])),
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (recent) => recent.length > 0,
        times: 36,
      }),
    );

    expect(times.length).toBeGreaterThan(0);
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(resetAt);
    }
  }).pipe(logLevel),
  { timeout: 300_000 },
);
