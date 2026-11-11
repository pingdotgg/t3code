import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { awaitDrained, produce } from "./fixtures/queue-sink-client.ts";
import { ResultQueue, SourceQueue } from "./fixtures/queue-sink-shared.ts";
import QueueSinkWorker from "./fixtures/queue-sink-worker.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy, matching
// the process topology of `alchemy dev` (see MakeOptions.sidecar).
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

/**
 * Under `alchemy dev` `QueueSinkBinding` rides the local Worker's native
 * queue binding, so the same source → transform → sink fixture as the live
 * suite runs entirely against the local broker.
 */
test.provider(
  "local QueueSink drains a stream through source → transform → sink",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* SourceQueue;
          const results = yield* ResultQueue;
          const worker = yield* QueueSinkWorker;
          return {
            sourceId: source.queueId,
            resultId: results.queueId,
            url: worker.url.as<string>(),
          };
        }),
      );

      // `dev:` ids prove no cloud queue was created; the worker is local.
      expect(deployed.sourceId).toMatch(/^dev:/);
      expect(deployed.resultId).toMatch(/^dev:/);
      expect(deployed.url).toMatch(/^http:\/\/localhost:\d+$/);

      yield* produce(deployed.url, { run: "local", count: 250 });
      const snapshot = yield* awaitDrained(deployed.url, "local", 250);
      expect(snapshot).toEqual({ distinct: 250, transformed: true });

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:queue",
      "provider:cloudflare:worker",
      "local",
    ],
    timeout: 120_000,
  },
);
