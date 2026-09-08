import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Output from "@/Output";

// ── Worker `env` Output inference guards ───────────────────────────────────
//
// `WorkerBindingResource` admits Outputs that resolve to a plain env value
// (`Output<Json | Redacted<Json>>`). Before that arm existed, a single
// Output env value (e.g. `Alchemy.makeRandom`) failed the `env` constraint,
// TypeScript fell back to the constraint's index signature, and EVERY
// `InferEnv` key collapsed to the full binding union. These probes pin the
// per-key inference.
//
// Note: whole-resource Outputs (`Output.of(queue)`) still compile — `Input<T>`
// wraps the whole union in `Output<T>`, so any Output whose A is structurally
// Json is admitted upstream of `WorkerBindingResource`. They are rejected at
// deploy time by `bindWorkerAsyncBindings` instead.

declare const queue: Cloudflare.Queues.Queue;

export const Worker = Cloudflare.Worker("EnvOutputTypeProbe", {
  script: "export default {}",
  env: {
    URL: "https://example.com",
    SECRET: Alchemy.makeRandom("Secret"),
    STR: Output.literal("str"),
    QUEUE: queue,
  },
});

type Env = Cloudflare.InferEnv<typeof Worker>;
declare const env: Env;

// An Output env value must not collapse sibling keys to the binding union.
export const _url: string = env.URL;
// `Output<Redacted<string>>` (makeRandom) infers as a decrypted string.
export const _secret: string = env.SECRET;
// `Output<string>` infers as a string.
export const _str: string = env.STR;
