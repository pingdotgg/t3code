import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config } from "effect";
import * as Effect from "effect/Effect";
import type { Counter as CounterClass } from "./src/worker.ts";

export const DB = Cloudflare.D1Database("DB");

export const Bucket = Cloudflare.R2Bucket("Bucket");

// Queue producer + consumer wiring (both sides exercised by the same worker).
// The Worker sends a message via `env.QUEUE.send(...)` from POST /queue/send,
// then receives and persists it via its `queue(batch)` handler — end-to-end
// regression guard for the Queue, QueueBinding, and QueueConsumer resources.
export const Queue = Cloudflare.Queue("Queue");

export const Counter = Cloudflare.DurableObjectNamespace<CounterClass>(
  "Counter",
  {
    className: "Counter",
  },
);

export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;

export const Worker = Cloudflare.Worker("Worker", {
  main: "./src/worker.ts",
  assets: {
    directory: "./public",
  },
  env: {
    // Self-contained default so the example deploys without external secrets;
    // the integ test asserts this value round-trips through env.API_KEY.
    API_KEY: Config.redacted("SOME_API_KEY").pipe(
      Config.withDefault("SOME_API_KEY"),
    ),
    DB,
    Bucket,
    Queue,
    Counter,
  },
});

export default Alchemy.Stack(
  "CloudflareWorker",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const queue = yield* Queue;
    const worker = yield* Worker;
    // create a random resource to test redacted storage
    yield* Alchemy.Random("Random");

    // Register the same worker script as a consumer of Queue. The worker's
    // `queue(batch)` handler (see src/worker.ts) receives each message batch.
    yield* Cloudflare.QueueConsumer("QueueConsumer", {
      queueId: queue.queueId,
      scriptName: worker.workerName,
      settings: {
        batchSize: 10,
        maxRetries: 3,
        maxWaitTimeMs: 5000,
      },
    });

    return worker.url;
  }),
);
