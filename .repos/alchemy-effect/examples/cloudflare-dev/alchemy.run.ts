import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Counter, QueueMessages } from "./src/AsyncWorker.ts";
import EffectWorker from "./src/EffectWorker.ts";
import { SandboxLive } from "./src/SandboxContainer.ts";

export type AsyncWorkerEnv = Cloudflare.InferEnv<typeof AsyncWorker>;

const AsyncWorker = Effect.gen(function* () {
  const queue = yield* Cloudflare.Queues.Queue("AsyncWorkerQueue");
  const worker = yield* Cloudflare.Worker("AsyncWorker", {
    main: "./src/AsyncWorker.ts",
    assets: {
      directory: "./assets",
      runWorkerFirst: true,
    },
    env: {
      COUNTER: Cloudflare.DurableObject<Counter>("Counter", {
        className: "Counter",
      }),
      QUEUE: queue,
      MESSAGES: Cloudflare.DurableObject<QueueMessages>("QueueMessages", {
        className: "QueueMessages",
      }),
      MY_VARIABLE: "my-variable-abc123",
      MY_SECRET: Config.redacted("MY_SECRET").pipe(
        Config.withDefault(Redacted.make("my-secret-abc123")),
      ),
    },
  });
  yield* Cloudflare.Queues.Consumer("Consumer", {
    queueId: queue.queueId,
    scriptName: worker.workerName,
  });
  return worker;
});

export default Alchemy.Stack(
  "CloudflareDev",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const asyncWorker = yield* AsyncWorker;
    const effectWorker = yield* EffectWorker;

    return {
      asyncWorker: asyncWorker.url,
      effectWorker: effectWorker.url,
    };
  }).pipe(Effect.provide(SandboxLive)),
);
