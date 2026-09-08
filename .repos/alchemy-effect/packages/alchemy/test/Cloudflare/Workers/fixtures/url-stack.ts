import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import UrlEffectWorker from "./url-effect-worker.ts";

export const UrlAsyncWorker = Cloudflare.Worker("UrlAsyncWorker", {
  main: pathe.resolve(import.meta.dirname, "url-async-worker.ts"),
  env: {
    PUBLIC_URL: Cloudflare.Worker.URL,
  },
});

export type UrlAsyncWorkerEnv = Cloudflare.InferEnv<typeof UrlAsyncWorker>;

// Compile-time guarantee that `InferEnv` maps the `Worker.URL` tag to `string`.
type _AssertPublicUrlIsString = UrlAsyncWorkerEnv["PUBLIC_URL"] extends string
  ? true
  : never;
const _typecheck: _AssertPublicUrlIsString = true;
void _typecheck;

export default Alchemy.Stack(
  "WorkerUrlStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const effectWorker = yield* UrlEffectWorker;
    const asyncWorker = yield* UrlAsyncWorker;

    return {
      effectUrl: effectWorker.url.as<string>(),
      asyncUrl: asyncWorker.url.as<string>(),
    };
  }),
);
