import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import * as Effect from "effect/Effect";
import * as path from "pathe";
import RateLimitEffectWorker from "./effect.ts";

export const AsyncWorker = Cloudflare.Worker("RateLimitAsyncWorker", {
  main: path.resolve(import.meta.dirname, "async.ts"),
  url: true,
  env: {
    THROTTLE: Cloudflare.RateLimit("THROTTLE", {
      namespaceId: 11_002,
      simple: { limit: 2, period: 10 },
    }),
  },
});

export type AsyncWorkerEnv = Cloudflare.InferEnv<typeof AsyncWorker>;

export default Alchemy.Stack(
  "RateLimitTestStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const asyncWorker = yield* AsyncWorker;
    const effectWorker = yield* RateLimitEffectWorker;
    return {
      asyncUrl: asyncWorker.url.as<string>(),
      effectUrl: effectWorker.url.as<string>(),
    };
  }),
);
