import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Counter as CounterClass } from "./src/AsyncWorker.ts";
import EffectWorker from "./src/EffectWorker.ts";

export const Counter = Cloudflare.DurableObjectNamespace<CounterClass>(
  "Counter",
  {
    className: "Counter",
  },
);

export type AsyncWorkerEnv = Cloudflare.InferEnv<typeof AsyncWorker>;

export const AsyncWorker = Cloudflare.Worker("AsyncWorker", {
  main: "./src/AsyncWorker.ts",
  env: {
    COUNTER: Counter,
    MY_VARIABLE: "my-variable-abc123",
    MY_SECRET: Config.redacted("MY_SECRET").pipe(
      Config.withDefault(Redacted.make("my-secret-abc123")),
    ),
  },
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
  }),
);
