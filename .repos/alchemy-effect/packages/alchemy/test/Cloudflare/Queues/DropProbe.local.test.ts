import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Regression test for the secondary symptom of #1109: when no consumer is
// registered for a queue, the dev registry's `ExternalQueueConsumer` accepts
// and drops the message with a warning — but it must still settle the
// producer's `send()` promise. It previously responded without draining the
// request body, which left `send()` pending forever (workerd's queue client
// only settles once the body is consumed).
test.provider(
  "plain worker send() to unconsumed queue resolves",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* Cloudflare.Queues.Queue("DropProbeQueue");
          const worker = yield* Cloudflare.Worker("drop-probe-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/queue-local-worker.ts",
            ),
            env: { QUEUE: queue },
          });
          return { queue, worker };
        }),
      );
      const client = yield* HttpClient.HttpClient;
      const res = yield* client
        .get(`${deployed.worker.url}/send?text=drop-me`)
        .pipe(Effect.timeout("20 seconds"), Effect.orDie);
      expect(res.status).toBe(200);
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
