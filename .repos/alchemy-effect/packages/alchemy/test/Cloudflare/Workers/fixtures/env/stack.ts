import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import * as Output from "@/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as path from "pathe";
import EnvEffectWorker from "./effect.ts";

export type AsyncWorkerEnv = Cloudflare.InferEnv<typeof AsyncWorker>;

export const AsyncWorker = Cloudflare.Worker("EnvAsyncWorker", {
  main: path.resolve(import.meta.dirname, "async.ts"),
  url: true,
  env: {
    STR: "hello",
    NUM: 42,
    BOOL: true,
    NULL: null,
    OBJ: { nested: { value: "ok" }, count: 7 },
    ARR: [1, 2, 3],
    OUTPUT_STR: Output.literal("output-str"),
    SECRET_STR: Redacted.make("shh"),
    SECRET_JSON: Redacted.make({
      token: "abc",
      scopes: ["read", "write"],
    }),
    CONFIG_STR: Config.string("CONFIG_STR"),
    CONFIG_NUM: Config.number("CONFIG_NUM"),
    CONFIG_REDACTED: Config.redacted("CONFIG_REDACTED"),
    CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
  },
});

export default Alchemy.Stack(
  "WorkerEnvTestStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const asyncWorker = yield* AsyncWorker;
    const effectWorker = yield* EnvEffectWorker;

    return {
      asyncUrl: asyncWorker.url.as<string>(),
      effectUrl: effectWorker.url.as<string>(),
    };
  }),
);
