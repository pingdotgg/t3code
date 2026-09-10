import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command. The
// Worker and Consumer lifecycles (vite child, consumer wiring, worker
// restart hooks) all run in the sidecar process.
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(import.meta.dirname, "vite-queue-fixture");
// Keep the temp clone under the workspace so Vite can express the project
// root relative to cwd (see the note on `tempRoot` in Vite.test.ts).
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureEntries = [
  "index.html",
  "package.json",
  "vite.config.ts",
  "worker.ts",
];

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
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(15),
        ]),
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

/**
 * Regression test for #1109: a `Queues.Consumer` registered against a
 * `Website.Vite` worker in dev. The Consumer depends on the site's
 * `workerName`, so the Vite child always boots before the consumer wiring
 * lands in `LocalRuntimeState` — the consumer's reconcile must then restart
 * the child through the `workerRestarts` hook (which `runVite` previously
 * never registered). Pre-fix, the producer binding resolved to the dev
 * registry's drop-and-warn stub: `queue()` never ran and `send()` hung.
 */
test.provider(
  "Vite dev: queue consumer on the site worker receives produced messages",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-vite-queue-",
        tempRoot,
        entries: fixtureEntries,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* Cloudflare.Queues.Queue("ViteJobsQueue");
          const site = yield* Cloudflare.Website.Vite("ViteQueueSite", {
            rootDir,
            main: "worker.ts",
            workersDev: true,
            compatibility: {
              date: "2024-09-23",
              flags: ["nodejs_compat"],
            },
            memo: { include: fixtureEntries },
            assets: { runWorkerFirst: true },
            dev: { port: 0 },
            env: { QUEUE: queue },
          });
          yield* Cloudflare.Queues.Consumer("ViteJobsConsumer", {
            queueId: queue.queueId,
            scriptName: site.workerName,
            settings: { batchSize: 5, maxRetries: 2, maxWaitTimeMs: 500 },
          });
          return { queue, site };
        }),
      );

      // The queue is emulated (`dev:` id — proof no cloud call ran) and the
      // site serves from the local dev proxy.
      expect(deployed.queue.queueId).toMatch(/^dev:/);
      expect(deployed.site.url).toMatch(/^http:\/\/localhost:\d+$/);

      // `send()` resolves (pre-fix it hung forever against the registry's
      // drop stub)...
      const sent = (yield* getJsonReady(
        `${deployed.site.url}/api/send?text=vite-queue-hello`,
      ).pipe(Effect.timeout("60 seconds"))) as { sent: string };
      expect(sent.sent).toBe("vite-queue-hello");

      // ...and the broker delivers to the fixture's queue() handler.
      const received = yield* getJsonReady(
        `${deployed.site.url}/api/received`,
      ).pipe(
        Effect.map((body) => (body as { received: string[] }).received),
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (received) => received.includes("vite-queue-hello"),
          times: 30,
        }),
      );
      expect(received).toContain("vite-queue-hello");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
