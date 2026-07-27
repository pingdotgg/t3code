import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import * as Effect from "effect/Effect";
import * as path from "pathe";
import AiSearchEffectBindingsWorker from "./effect-bindings-worker.ts";

/**
 * Deploys two Workers covering both AI Search binding flavors via both
 * access styles:
 * - The async worker takes the bindings through `env` (`SEARCH` is a
 *   single-instance `ai_search` binding; `NS` is an `ai_search_namespace`
 *   binding) and reads them as raw runtime objects.
 * - The Effect worker attaches the same two binding flavors via
 *   `Cloudflare.AI.Search.Search(...)` / `Cloudflare.AI.SearchNamespace(...)`
 *   and reads them through the Effect-native client.
 *
 * The single-instance binding is sourced from the `AiSearch` construct (not
 * the low-level `AiSearchInstance`), proving the construct's result is usable
 * anywhere an `AiSearchInstance` is — here, passed straight to a Worker's
 * `env`. The construct's `source` references the bucket and the worker's
 * `env` references the search + namespace, so the engine orders the deploy
 * bucket → instance/namespace → worker.
 */
export default Alchemy.Stack(
  "AiSearchBindingsStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("AiSearchBindingBucket", {});
    const namespace = yield* Cloudflare.AI.SearchNamespace(
      "AiSearchBindingNs",
      {},
    );
    const search = yield* Cloudflare.AI.Search("AiSearchBindingInstance", {
      source: bucket,
    });
    const asyncWorker = yield* Cloudflare.Worker("AiSearchBindingsWorker", {
      main: path.resolve(import.meta.dirname, "bindings-worker.ts"),
      url: true,
      env: { SEARCH: search, NS: namespace },
    });
    const effectWorker = yield* AiSearchEffectBindingsWorker;
    return {
      url: asyncWorker.url.as<string>(),
      effectUrl: effectWorker.url.as<string>(),
    };
  }),
);
